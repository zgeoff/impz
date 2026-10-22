import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FRAME_TYPES,
  OKSchema,
  RequestSchema,
  StartedSchema,
  decodeJsonPayload,
  decodeMessageFrame,
  encodeJsonFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockLeaseRecord } from '../../../testing/imps/build-mock-lease-record';
import { waitForOutcome } from '../../../testing/imps/wait-for-outcome';
import { startTestImpd } from '../../../testing/start-test-impd';
import type { TestImpdOptions } from '../../../testing/start-test-impd';
import { buildStubMounts } from '../../../testing/vm/build-stub-mounts';
import { buildStubUidProcesses } from '../../../testing/vm/build-stub-uid-processes';
import { startStubAgent } from '../../../testing/vm/start-stub-agent';
import { startStubInnerAgent } from '../../../testing/vm/start-stub-inner-agent';
import { startStubSessionAgent } from '../../../testing/vm/start-stub-session-agent';
import { readImpByName, updateImpActivity } from '../../platform/db/imps';
import { writeLease } from '../../platform/db/leases';
import { readVmIdentity, writeVmIdentity } from '../../vm/sleep/vm-identity';
import { buildImpPaths } from '../../vm/storage/data-layout';
import { createJails } from '../../vm/vmm/jail';

async function setupTest(
  options: Pick<TestImpdOptions, 'env' | 'frozenClockMs' | 'installBundle'> = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const chrootBase = mkdtempSync(join(tmpdir(), 'imp-runtime-jail-'));

  stack.defer(() => {
    rmSync(chrootBase, { recursive: true, force: true });
  });

  const processes = buildStubUidProcesses();
  const mounts = buildStubMounts();

  const jails = createJails({
    jailerBin: 'jailer',
    firecrackerBin: '/usr/local/bin/firecracker',
    chrootBase,
    run: mounts.run,
    readMounts: mounts.readMounts,
    log: () => {},
    ...processes.deps,
  });

  const harness = await startTestImpd(stack, { ...options, jails });

  return Object.assign(harness, { stack, chrootBase, processes });
}

test('it skips an idle sleep of an imp held after the idle loop looked', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  expect(outcome).toBe('skipped');
});

test('it skips a governor sleep of an imp held after the governor looked', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it skips an idle sleep of an imp active since the idle loop looked', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const seenActiveAt = imp.lastActiveAt.getTime();

  await updateImpActivity(ctx.db, imp.id, new Date(seenActiveAt + 1000));

  const outcome = await ctx.imps.trySleepImp(imp.id, 'idle', { by: 'idle', seenActiveAt });

  expect(outcome).toBe('skipped');
});

test('it sleeps an imp for the governor however recently it was active', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await updateImpActivity(ctx.db, imp.id, new Date(imp.lastActiveAt.getTime() + 1000));

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('slept');
});

test('it skips a background sleep of an imp with an open connection', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const release = ctx.imps.tracker.open(imp.id, 'proxy');

  onTestFinished(release);

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it skips a background sleep of an imp whose lock is taken', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  const holding = ctx.imps.lockImp('dev', () => gate.promise);

  await waitFor(() => {
    expect(ctx.imps.isImpBusy(imp.id)).toBeTrue();
  });

  const outcome = await ctx.imps.trySleepImp(imp.id, 'budget', { by: 'governor' });

  gate.resolve();

  await holding;

  expect(outcome).toBe('skipped');
});

test('it waits for a young guest to reach the minimum uptime before it sleeps it', async () => {
  const ctx = await setupTest({
    env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '300' },
    frozenClockMs: Date.parse('2026-10-09T12:00:00Z'),
  });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.setGuestUptime(100);

  const asleep = await ctx.imps.sleepImp('dev');

  const waitedMs = ctx.logs
    .map((line) => /waited (?<ms>\d+)ms for a young guest/u.exec(line)?.groups?.['ms'])
    .find((durationMs) => durationMs !== undefined);

  expect(asleep.state).toBe('sleeping');
  expect(waitedMs).toBe('200');
});

test('it gives way to a request while an idle sleep waits for a young guest', async () => {
  const ctx = await setupTest({ env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000' } });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.setGuestUptime(0);

  const sleeping = ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  await waitFor(() => {
    expect(ctx.imps.isWaitingForYoungGuest(imp.id)).toBeTrue();
  });

  const opened = { release: () => {} };

  onTestFinished(() => {
    opened.release();
  });

  const request = ctx.imps.requireRunning('dev', (found) => {
    opened.release = ctx.imps.tracker.open(found.id, 'proxy');
  });

  const settled = await waitForOutcome(sleeping, 2000);
  const outcome = await sleeping;
  const running = await request;

  expect(settled).toBe('done');
  expect(outcome).toBe('skipped');
  expect(running.imp.state).toBe('running');
  expect(running.wokeMs).toBeNull();
  expect(ctx.logs).toContain('impd: dev: sleep (idle) gave way: the imp turned busy');
});

test('it gives way to a hold while an idle sleep waits for a young guest', async () => {
  const ctx = await setupTest({ env: { IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000' } });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.fake.setGuestUptime(0);

  const sleeping = ctx.imps.trySleepImp(imp.id, 'idle', {
    by: 'idle',
    seenActiveAt: imp.lastActiveAt.getTime(),
  });

  await waitFor(() => {
    expect(ctx.imps.isWaitingForYoungGuest(imp.id)).toBeTrue();
  });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const settled = await waitForOutcome(sleeping, 2000);
  const outcome = await sleeping;
  const after = await readImpByName(ctx.db, 'dev');

  expect(settled).toBe('done');
  expect(outcome).toBe('skipped');
  expect(after?.state).toBe('running');
  expect(ctx.logs).toContain('impd: dev: sleep (idle) gave way: the imp turned busy');
});

test('it sleeps young guests at once when the governor makes room for a boot', async () => {
  const ctx = await setupTest({
    env: {
      IMP_RAM_BUDGET_MIB: '1000',
      IMP_DEFAULT_MEMORY_MIB: '256',
      IMP_BOOT_RESERVE_PERCENT: '100',
      IMP_SLEEP_MIN_GUEST_UPTIME_MS: '600000',
    },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'a' });
  await ctx.imps.createImp({ name: 'b' });
  await ctx.imps.createImp({ name: 'c' });

  ctx.fake.setGuestUptime(0);

  const admitted = await waitForOutcome(ctx.imps.createImp({ name: 'big', memoryMib: 720 }), 2000);
  const imps = await ctx.imps.listImps();

  expect(admitted).toBe('done');

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'sleeping'],
    ['big', 'running'],
    ['c', 'sleeping'],
  ]);

  expect(ctx.logs).not.toSatisfyAny((line: string) => line.includes('for a young guest'));
});

test('it sleeps held and connected imps when impd stops', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const until = new Date(ctx.now() + 60_000);

  await writeLease(ctx.db, buildMockLeaseRecord({ impId: imp.id, until }), {
    at: ctx.now(),
    reason: 'held',
  });

  const release = ctx.imps.tracker.open(imp.id, 'exec');

  onTestFinished(release);

  await ctx.imps.sleepAllImps();

  const after = await readImpByName(ctx.db, 'dev');

  expect(after?.state).toBe('sleeping');
});

test('it counts an exec before its wake and drops it when the wake fails', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const exec = ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  await gate.reached;

  const during = ctx.imps.tracker.count(imp.id, 'exec');

  gate.release();

  expect(exec).rejects.toThrow('boot failed');
  expect(during).toBe(1);
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it counts a tunnel as a tunnel, not an exec, from before its wake', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');

  ctx.fake.queue('boot', 'fail');

  const dial = ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:5432' }, 'tunnel');

  await gate.reached;

  const tunnels = ctx.imps.tracker.count(imp.id, 'tunnel');
  const execs = ctx.imps.tracker.count(imp.id, 'exec');

  gate.release();

  expect(dial).rejects.toThrow('boot failed');
  expect(tunnels).toBe(1);
  expect(execs).toBe(0);
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it waits for a boot under way and sleeps that imp when impd stops', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.stopImp('dev');

  const gate = ctx.fake.hold('boot');
  const starting = ctx.imps.startImp('dev');

  await gate.reached;

  const stopping = ctx.imps.sleepAllImps();

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  gate.release();

  await Promise.all([starting, stopping]);

  const after = await readImpByName(ctx.db, 'dev');

  expect(after?.state).toBe('sleeping');
});

test('it refuses a boot once impd is stopping', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.imps.stopImp('dev');
  await ctx.imps.sleepAllImps();

  expect(ctx.imps.startImp('dev')).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'impd is stopping',
  });
});

test('it neither hangs nor wakes anything when a governor pass meets impd stopping', async () => {
  const ctx = await setupTest({
    env: { IMP_RAM_BUDGET_MIB: '500', IMP_DEFAULT_MEMORY_MIB: '256' },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'a' });
  await ctx.imps.createImp({ name: 'b' });

  const gate = ctx.fake.hold('sleep');
  const enforcing = ctx.governor.enforce();
  const stopping = ctx.imps.sleepAllImps();

  await gate.reached;

  gate.release();

  const enforced = await waitForOutcome(enforcing, 10_000);
  const stopped = await waitForOutcome(stopping, 10_000);
  const imps = await ctx.imps.listImps();

  expect(enforced).toBe('done');
  expect(stopped).toBe('done');
  expect(imps.map((imp) => imp.state)).toStrictEqual(['sleeping', 'sleeping']);
}, 30_000);

test('it refuses a create that impd stopping cuts short, and records it as an error', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.sleepAllImps();

  expect(ctx.imps.createImp({ name: 'late' })).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  });

  const late = await readImpByName(ctx.db, 'late');

  expect(late).toMatchObject({ state: 'error', error: 'impd is stopping' });
});

test('it removes the imp once a create under way when its destroy was issued has booted', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const gate = ctx.fake.hold('boot');
  const creating = ctx.imps.createImp({ name: 'dev' });

  await gate.reached;

  const found = await readImpByName(ctx.db, 'dev');

  invariant(found);

  const destroying = ctx.imps.destroyImp('dev');

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(found.id)).toBe(2);
  });

  gate.release();

  const created = await creating;

  await destroying;

  const left = await readImpByName(ctx.db, 'dev');

  expect(created.state).toBe('running');
  expect(left).toBeUndefined();
  expect(ctx.fake.alive.size).toBe(0);
});

test('it removes a running imp whose VM takes long to exit on the first call', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.processes.ownRoot(join(ctx.chrootBase, 'firecracker', imp.id, 'root'), 900_001);
  ctx.processes.start(900_001, 4242);

  // Firecracker takes this long to free many GiB of guest memory, past the
  // scans in which a process that still runs counts as surviving its kills.
  ctx.processes.exitSlowly(4242, 200);

  await ctx.imps.destroyImp('dev');

  const left = await readImpByName(ctx.db, 'dev');

  expect(left).toBeUndefined();
});

test('it lists the imps while a removal waits for its VM to exit', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  ctx.processes.ownRoot(join(ctx.chrootBase, 'firecracker', imp.id, 'root'), 900_001);
  ctx.processes.start(900_001, 4242);
  ctx.processes.exitSlowly(4242, 200);

  const pause = ctx.processes.holdPause(100);
  const removing = ctx.imps.destroyImp('dev');

  await Promise.race([pause.reached, removing]);

  const listed = await ctx.imps.listImps();

  pause.release();

  await removing;

  expect(listed).toPartiallyContain({ name: 'dev', state: 'running' });
});

test('it refuses a session exec on an agent from before sessions before it connects', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    },
    { stack: ctx.stack },
  );

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, session: 'main' }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.received).toBeEmpty();
  expect(ctx.imps.tracker.count(imp.id)).toBe(0);
});

test('it refuses a unix socket dial on an agent from before 0.6.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.5.0' });

  expect(
    ctx.imps.openDial('dev', { network: 'unix', address: '/run/docker.sock' }, 'ssh'),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
});

test('it sends a tcp dial to an agent from before 0.6.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.5.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openDial('dev', { network: 'tcp', address: '127.0.0.1:80' }, 'ssh');

  stream.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toStrictEqual([
    { op: 'dial', network: 'tcp', address: '127.0.0.1:80' },
  ]);
});

test('it refuses an outer exec to an imp with no agent version on record', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  rmSync(paths.vmIdentity);

  const opening = ctx.imps.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec');

  expect(opening).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(opening).rejects.toThrow("impd has no record of the imp's agent version");
  expect(agent.received).toBeEmpty();
});

test.each([
  ['a version that does not parse', 'dev'],
  ['a version from before outer exec', '0.15.0'],
])('it refuses an outer exec to an agent with %s', async (_label, agentVersion) => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, outer: true }, 'outer-exec'),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.received).toBeEmpty();
});

test('it sends an outer exec to an agent from 0.16.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.16.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, outer: true },
    'outer-exec',
  );

  stream.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toStrictEqual([
    { op: 'exec.outer', argv: ['sh'], tty: true },
  ]);
});

test('it refuses an exec without CAP_SYS_ADMIN to an agent from before 0.20.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.19.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  const opening = ctx.imps.openExec('dev', { argv: ['sh'], tty: true, dropSysAdmin: true });

  expect(opening).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });
  expect(opening).rejects.toThrow('no exec without CAP_SYS_ADMIN');
  expect(agent.received).toBeEmpty();
});

test('it refuses an exec without CAP_SYS_ADMIN to an imp with no agent version on record', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  rmSync(paths.vmIdentity);

  expect(
    ctx.imps.openExec('dev', { argv: ['sh'], tty: true, dropSysAdmin: true }),
  ).rejects.toMatchObject({ code: 'AGENT_OUTDATED' });

  expect(agent.received).toBeEmpty();
});

test('it sends an exec without CAP_SYS_ADMIN to an agent from 0.20.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.20.0' });

  const agent = await startStubAgent(
    paths.vsockSocket,
    (socket) => {
      socket.write(encodeMessageFrame(FRAME_TYPES.started, StartedSchema, { pid: 9 }));
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec('dev', { argv: ['sh'], tty: true, dropSysAdmin: true });

  stream.close();

  expect(agent.received.map((frame) => decodeJsonPayload(frame))).toStrictEqual([
    { op: 'exec', argv: ['sh'], tty: true, drop_sys_admin: true },
  ]);
});

test('it never idle-sleeps an image builder', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const builder = await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  const outcome = await ctx.imps.trySleepImp(builder.id, 'idle', {
    by: 'idle',
    seenActiveAt: ctx.now() + 60_000,
  });

  expect(outcome).toBe('skipped');
});

test('it never sleeps an image builder for the governor', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const builder = await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });
  const outcome = await ctx.imps.trySleepImp(builder.id, 'budget', { by: 'governor' });

  expect(outcome).toBe('skipped');
});

test('it refuses a dial into an image builder', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(
    ctx.imps.openDial('imp-build-x', { network: 'tcp', address: '127.0.0.1:80' }, 'ssh'),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it refuses an attach without a wake to an image builder', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(
    ctx.imps.openAttach('imp-build-x', { session: 'main', wake: false }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it refuses to find the agent of an image builder', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'imp-build-x', kind: 'builder' });

  expect(ctx.imps.readAgent('imp-build-x')).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test("it removes an imp's session logs when the imp is destroyed", async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = decodeMessageFrame(RequestSchema, request).op === 'session.tap';

      socket.write(
        encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            executionGeneration: 'c'.repeat(32),
            bufferStart: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });

  stream.close();

  await ctx.imps.destroyImp('dev');

  expect(existsSync(paths.sessionLogsDir)).toBeFalse();
});

test('it logs again for an imp made again under the id of one destroyed, as on a move home', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const first = await ctx.imps.createImp({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, first.id);
  const firstIdentity = readVmIdentity(paths);

  invariant(firstIdentity);
  writeVmIdentity(paths, { ...firstIdentity, agentVersion: '0.18.0' });

  const firstAgent = await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = decodeMessageFrame(RequestSchema, request).op === 'session.tap';

      socket.write(
        encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            executionGeneration: 'c'.repeat(32),
            bufferStart: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const firstStream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });

  firstStream.close();
  firstAgent.close();

  await ctx.imps.destroyImp('dev');
  await ctx.imps.createImp({ name: 'dev', id: first.id });

  const secondIdentity = readVmIdentity(paths);

  invariant(secondIdentity);
  writeVmIdentity(paths, { ...secondIdentity, agentVersion: '0.18.0' });

  await startStubAgent(
    paths.vsockSocket,
    (socket, request, frames) => {
      if (frames.length !== 1) {
        return;
      }

      const isTap = decodeMessageFrame(RequestSchema, request).op === 'session.tap';

      socket.write(
        encodeMessageFrame(FRAME_TYPES.started, StartedSchema, {
          pid: 9,
          session: 'main',
          created: !isTap,
          output: {
            bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
            executionGeneration: 'c'.repeat(32),
            bufferStart: 0,
            end: 0,
            offset: 0,
            prelude: 0,
            log: true,
          },
        }),
      );
    },
    { stack: ctx.stack },
  );

  const stream = await ctx.imps.openExec(
    'dev',
    { argv: ['sh'], tty: true, session: 'main', log: true },
    'session-log',
  );

  onTestFinished(stream.close);

  await waitFor(() => {
    expect(existsSync(`${paths.sessionLogsDir}/${'c'.repeat(32)}/meta.json`)).toBeTrue();
  });
});

test('it shows the inner container of an awake imp as its agent last reported it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  const shown = await ctx.imps.toApi(record);

  expect(shown.inner).toStrictEqual({
    up: false,
    restarts: 3,
    lastError: 'start inner init: exit status 1',
  });
});

test('it shows no inner container once the agent stops answering', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3 },
    stack: ctx.stack,
  });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  agent.close();

  const answer = await ctx.imps.readActivity(record);
  const shown = await ctx.imps.toApi(record);

  expect(answer).toBeNull();
  expect(shown).not.toContainKey('inner');
});

test('it shows no inner container from before a sleep once the imp wakes', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubInnerAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3 },
    stack: ctx.stack,
  });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  agent.close();

  await ctx.imps.sleepImp('dev');

  const awake = await ctx.imps.wakeImp('dev');

  expect(awake.state).toBe('running');
  expect(awake).not.toContainKey('inner');
});

test('it shows no inner container for an agent from before 0.14.0', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, request) => {
      const isPing = decodeMessageFrame(RequestSchema, request).op === 'ping';

      // plain JSON: the schema's encoder writes boot_steps and sessions, which 0.13.0 never sent
      const answer = isPing
        ? { ok: true, version: '0.13.0' }
        : { tcp_established: 0, exec_sessions: 0, load1: 0 };

      socket.end(encodeJsonFrame(FRAME_TYPES.response, answer));
    },
    { stack: ctx.stack },
  );

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  await ctx.imps.readActivity(record);

  const shown = await ctx.imps.toApi(record);

  expect(shown).not.toContainKey('inner');
});

test('it refuses an exec that requires the broker without a grant', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the imp has no grant, so impd sets no broker variables',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs an exec without the requirement on an imp with no grant', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  const stream = await ctx.imps.openExec('dev', { argv: ['true'], tty: false });

  stream.close();

  expect(agent.readExecs()).toHaveLength(1);
});

test('it refuses the exec when the CA bundle step fails', async () => {
  const ctx = await setupTest({ installBundle: () => Promise.reject(new Error('no /bin/sh')) });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: no /bin/sh',
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it tries the CA bundle step again at the next exec after one failed', async () => {
  const install = { fail: true };

  const ctx = await setupTest({
    installBundle: () =>
      install.fail ? Promise.reject(new Error('no /bin/sh')) : Promise.resolve(),
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const failed = await ctx.imps
    .openExec('dev', { argv: ['true'], tty: false, require: ['broker'] })
    .then(
      () => null,
      (error: unknown) => error,
    );

  install.fail = false;

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  expect(failed).toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: 'the broker CA bundle is not in this boot of the guest: no /bin/sh',
    },
  });

  expect(agent.readExecs()).toHaveLength(1);

  expect(agent.readExecs()[0]?.env).toContain(
    `HTTPS_PROXY=http://10.66.0.1:${String(ctx.config.brokerPort)}`,
  );
});

test('it never sends the requirement to the agent', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const [sent] = agent.readExecPayloads();

  invariant(sent !== undefined);

  expect(sent).not.toHaveProperty('require');
});

test('it runs the CA bundle step before the first exec of a boot, with the broker variables', async () => {
  const sentAtInstall: number[] = [];
  const agentRef: { readExecs: () => readonly unknown[] } = { readExecs: () => [] };

  const ctx = await setupTest({
    installBundle: () => {
      sentAtInstall.push(agentRef.readExecs().length);

      return Promise.resolve();
    },
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  agentRef.readExecs = agent.readExecs;

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  stream.close();

  const env = agent.readExecs()[0]?.env;

  expect(sentAtInstall).toStrictEqual([0]);
  expect(agent.readExecs()).toHaveLength(1);
  expect(env).toContain(`HTTPS_PROXY=http://10.66.0.1:${String(ctx.config.brokerPort)}`);
  expect(env).toContain('SSL_CERT_FILE=/etc/imp/broker-ca.pem');
});

test('it runs the CA bundle step again after a reboot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const first = await ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  first.close();

  await ctx.imps.lockImp('dev', async (locked) => {
    const halted = await ctx.imps.haltImp(locked, false);

    await ctx.imps.bootImp(halted);
  });

  const second = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
  });

  second.close();

  expect(ctx.bundleInstalls).toHaveLength(2);
});

test('it installs the broker CA within the wake a warm move left it to', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_EXAMPLE' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.imps.sleepImp('dev');
  await ctx.db.updateTable('imps').set({ trust_pending: 1 }).where('id', '=', imp.id).execute();
  await ctx.imps.wakeImp('dev');

  expect(ctx.bundleInstalls).toStrictEqual([buildImpPaths(ctx.dataDir, imp.id).vsockSocket]);
});

test('it clears the pending CA install in the wake that does it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  await ctx.imps.sleepImp('dev');
  await ctx.db.updateTable('imps').set({ trust_pending: 1 }).where('id', '=', imp.id).execute();
  await ctx.imps.wakeImp('dev');

  const record = await readImpByName(ctx.db, 'dev');

  expect(record?.isTrustPending).toBeFalse();
});

test('it installs no broker CA in a wake with no install pending', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });
  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_EXAMPLE' });
  await ctx.broker.addGrant('dev', 'gh');
  await ctx.imps.sleepImp('dev');
  await ctx.imps.wakeImp('dev');

  expect(ctx.bundleInstalls).toBeEmpty();
});

test('it refuses an env that replaces a broker variable, and names it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
      env: ['SSL_CERT_FILE=/tmp/mine.pem'],
    }),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: {
      reason: 'broker_not_ready',
      detail: "the exec's env sets SSL_CERT_FILE, which the broker sets",
    },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it passes an env variable the broker does not set', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stream = await ctx.imps.openExec('dev', {
    argv: ['true'],
    tty: false,
    require: ['broker'],
    env: ['TERM=xterm'],
  });

  stream.close();

  expect(agent.readExecs()[0]?.env).toContain('TERM=xterm');
});

test('it refuses the broker requirement for an outer exec', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  expect(
    ctx.imps.openExec(
      'dev',
      { argv: ['true'], tty: false, require: ['broker'], outer: true },
      'outer-exec',
    ),
  ).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    data: { reason: 'broker_not_ready', detail: 'an exec in the agent gets no broker variables' },
  });

  expect(agent.readExecs()).toBeEmpty();
});

test('it runs no lifecycle operation between the CA bundle step and the start', async () => {
  const install = { release: () => {}, reached: () => {} };

  const reached = new Promise<void>((resolve) => {
    install.reached = resolve;
  });

  const ctx = await setupTest({
    installBundle: () =>
      new Promise<void>((resolve) => {
        install.release = resolve;

        install.reached();
      }),
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const order: string[] = [];

  const exec = (async () => {
    const stream = await ctx.imps.openExec('dev', {
      argv: ['true'],
      tty: false,
      require: ['broker'],
    });

    order.push(`exec started (${String(agent.readExecs().length)} sent)`);
    stream.close();
  })();

  await reached;

  const locked = ctx.imps.lockImp('dev', () => {
    order.push('lifecycle');

    return Promise.resolve();
  });

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  const beforeRelease = [...order];

  install.release();

  await Promise.all([exec, locked]);

  expect(beforeRelease).toBeEmpty();
  expect(order).toStrictEqual(['exec started (1 sent)', 'lifecycle']);
});

test('it boots the imp again and checks again when a stop takes the lock before the exec', async () => {
  const order: string[] = [];

  const ctx = await setupTest({
    installBundle: () => {
      order.push('bundle');

      return Promise.resolve();
    },
  });

  await ctx.createTestImage('ubuntu');

  const imp = await ctx.imps.createImp({ name: 'dev' });

  const agent = await startStubSessionAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, {
    stack: ctx.stack,
  });

  await ctx.broker.addSecret({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.broker.addGrant('dev', 'gh');

  const stopGate = Promise.withResolvers<void>();

  onTestFinished(() => {
    stopGate.resolve();
  });

  const stopping = ctx.imps.lockImp('dev', async (locked) => {
    await stopGate.promise;

    await ctx.imps.haltImp(locked, false);

    order.push('stopped');
  });

  const opening = ctx.imps.openExec('dev', { argv: ['true'], tty: false, require: ['broker'] });

  await waitFor(() => {
    expect(ctx.imps.countLockQueue(imp.id)).toBe(2);
  });

  const bootsBefore = ctx.fake.boots.length;

  stopGate.resolve();

  const stream = await opening;

  stream.close();

  await stopping;

  expect(order).toStrictEqual(['stopped', 'bundle']);
  expect(ctx.fake.boots).toHaveLength(bootsBefore + 1);

  expect(agent.readExecs()[0]?.env).toContain(
    `HTTPS_PROXY=http://10.66.0.1:${String(ctx.config.brokerPort)}`,
  );
});
