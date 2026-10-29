import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import fc from 'fast-check';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestImpdPool } from '../../../testing/imps/create-test-impd-pool';
import { readBrokenInvariants } from '../../../testing/imps/read-broken-invariants';
import { waitForOutcome } from '../../../testing/imps/wait-for-outcome';
import { runWithStack } from '../../../testing/platform/run-with-stack';
import { startTestImpd } from '../../../testing/start-test-impd';
import { StubVmError } from '../../../testing/vm/build-stub-vmm';
import type { VmOutcome } from '../../../testing/vm/build-stub-vmm';
import { writeTestSnapshot } from '../../../testing/vm/write-test-snapshot';
import { createImp, listImps, readImpByName, updateImpActivity } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import { readSnapshotMeta, writeSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import { buildImpPaths } from '../../vm/storage/data-layout';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack, { env: readImpEnv() });
}

test('it lets a restore waiting for admission past the governor sleeping its imp', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '1000');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '256');
  updateEnv('IMP_BOOT_RESERVE_PERCENT', '100');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const x = await ctx.client.imps.create({ name: 'x' });
  const first = await ctx.client.imps.create({ name: 'a' });
  const checkpoint = await ctx.client.checkpoints.create({ name: 'a' });

  await updateImpActivity(ctx.db, x.id, new Date(1000));
  await updateImpActivity(ctx.db, first.id, new Date(2000));

  const sleepGate = ctx.fake.hold('sleep');
  const admitting = ctx.client.imps.create({ name: 'b', memoryMib: 720 });

  await sleepGate.reached;

  const restoring = ctx.client.checkpoints.restore({ name: 'a', checkpoint: checkpoint.id });

  await waitFor(async () => {
    const halted = await readImpByName(ctx.db, 'a');

    expect(halted?.state).toBe('stopped');
  });

  sleepGate.release();

  const admitted = await waitForOutcome(admitting, 10_000);
  const restored = await waitForOutcome(restoring, 10_000);

  await ctx.imps.waitForLifecycle();

  const xAfter = await readImpByName(ctx.db, 'x');
  const aAfter = await readImpByName(ctx.db, 'a');
  const broken = await readBrokenInvariants(ctx, false);

  expect(admitted).toBe('done');
  expect(restored).toBe('done');
  expect(xAfter?.state).toBe('sleeping');
  expect(aAfter?.state).toBe('running');
  expect(broken).toBeEmpty();
});

test('it leaves an imp whose boot fails in error with no VM and no reservation', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  ctx.fake.queue('boot', 'fail');

  const creating = ctx.client.imps.create({ name: 'dev' });

  expect(creating).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await readImpByName(ctx.db, 'dev');
  const usage = await ctx.governor.readUsage();
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
  expect(usage).toStrictEqual({ usedMib: 0, reservedMib: 0, headroomMib: 0 });
  expect(broken).toBeEmpty();
});

test('it finds a VM that died right after its boot stopped on the next read', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  ctx.fake.queue('boot', 'die');

  const created = await ctx.client.imps.create({ name: 'dev' });
  const before = await readBrokenInvariants(ctx, false);
  const read = await ctx.client.imps.get({ name: 'dev' });
  const after = await readBrokenInvariants(ctx, true);

  expect(created.state).toBe('running');
  expect(before).toBeEmpty();
  expect(read.state).toBe('stopped');
  expect(after).toBeEmpty();
});

test('it boots an imp cold when its wake fails', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');

  const cold = await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakes).toBeEmpty();
  expect(ctx.fake.boots).toHaveLength(2);
  expect(cold.state).toBe('running');
});

test('it leaves an imp in error when its wake and the cold boot after it fail', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  ctx.fake.queue('wake', 'fail');
  ctx.fake.queue('boot', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await readImpByName(ctx.db, 'dev');
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
  expect(broken).toBeEmpty();
});

test('it drops the used snapshot when the budget refuses the cold boot after a failed wake', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '900');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');
  updateEnv('IMP_BOOT_RESERVE_PERCENT', '100');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const first = await ctx.client.imps.create({ name: 'a' });

  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  ctx.advance(30_000);
  ctx.fake.queue('wake', 'fail');

  const waking = ctx.client.imps.wake({ name: 'a' });

  expect(waking).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const paths = buildImpPaths(ctx.dataDir, first.id);

  const imp = await readImpByName(ctx.db, 'a');
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it keeps the snapshot when the budget refuses a cold boot before anything loaded', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '900');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');
  updateEnv('IMP_BOOT_RESERVE_PERCENT', '100');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const first = await ctx.client.imps.create({ name: 'a' });

  await ctx.client.imps.sleep({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.create({ name: 'c' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });
  await ctx.client.imps.hold({ name: 'c', seconds: 600 });

  ctx.advance(30_000);

  const paths = buildImpPaths(ctx.dataDir, first.id);

  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  const waking = ctx.client.imps.wake({ name: 'a' });

  expect(waking).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  const imp = await readImpByName(ctx.db, 'a');
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('sleeping');
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it releases the reservation of a cold boot that fails after its admit', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  writeTestSnapshot(paths, Date.now(), { ...ctx.readIdentity(), firecrackerVersion: 'v0.1.0' });

  ctx.fake.queue('boot', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await readImpByName(ctx.db, 'dev');
  const usage = await ctx.governor.readUsage();
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('error');
  expect(usage).toStrictEqual({ usedMib: 0, reservedMib: 0, headroomMib: 0 });
  expect(broken).toBeEmpty();
});

test('it keeps the VM running when its snapshot fails', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'fail');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const imp = await readImpByName(ctx.db, 'dev');
  const broken = await readBrokenInvariants(ctx, true);

  expect(imp?.state).toBe('running');
  expect(broken).toBeEmpty();
});

test('it stops the imp when its snapshot is lost after the kill', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  ctx.fake.queue('sleep', 'die');

  const sleeping = ctx.client.imps.sleep({ name: 'dev' });

  expect(sleeping).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  const imp = await readImpByName(ctx.db, 'dev');
  const broken = await readBrokenInvariants(ctx, false);

  expect(imp?.state).toBe('stopped');
  expect(existsSync(paths.snapshotDir)).toBeFalse();
  expect(broken).toBeEmpty();
});

test('it settles imps a restarted impd finds in every state', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  for (const name of [
    'alive',
    'dead',
    'dead-fresh-snapshot',
    'dead-old-snapshot',
    'asleep',
    'asleep-lost-snapshot',
    'stopped',
    'failed',
  ]) {
    await ctx.client.imps.create({ name });
  }

  const image = await ctx.images.resolveImage('ubuntu');

  const orphanPid = ctx.fake.spawnOrphan();

  const creatingLive = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating-live', imageId: image.id, slot: 20, ip: '10.66.0.82' }),
  );

  const creatingDead = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating-dead', imageId: image.id, slot: 21, ip: '10.66.0.86' }),
  );

  await updateImpState(ctx.db, creatingLive.id, {
    reason: 'failed',
    state: 'creating',
    pid: orphanPid,
  });

  await updateImpState(ctx.db, creatingDead.id, {
    reason: 'failed',
    state: 'creating',
    pid: 99_999,
  });

  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep-lost-snapshot' });
  await ctx.client.imps.stop({ name: 'stopped' });

  ctx.fake.queue('boot', 'fail');

  await ctx.client.imps.stop({ name: 'failed' });
  await Promise.allSettled([ctx.client.imps.start({ name: 'failed' })]);

  const dead = await readImpByName(ctx.db, 'dead');
  const deadFresh = await readImpByName(ctx.db, 'dead-fresh-snapshot');
  const deadOld = await readImpByName(ctx.db, 'dead-old-snapshot');
  const lostSnapshot = await readImpByName(ctx.db, 'asleep-lost-snapshot');

  invariant(typeof dead?.pid === 'number');
  invariant(typeof deadFresh?.pid === 'number');
  invariant(typeof deadOld?.pid === 'number');
  invariant(lostSnapshot);

  ctx.fake.alive.delete(dead.pid);
  ctx.fake.alive.delete(deadFresh.pid);
  ctx.fake.alive.delete(deadOld.pid);

  const lastActive = deadFresh.lastActiveAt.getTime();

  writeTestSnapshot(
    buildImpPaths(ctx.dataDir, deadFresh.id),
    lastActive + 1000,
    ctx.readIdentity(),
  );

  writeTestSnapshot(buildImpPaths(ctx.dataDir, deadOld.id), lastActive - 1000, ctx.readIdentity());
  rmSync(buildImpPaths(ctx.dataDir, lostSnapshot.id).memFile);

  const oldImps = ctx.imps;

  await ctx.restartImpd();

  const after = await listImps(ctx.db);

  const states = Object.fromEntries(after.map((imp) => [imp.name, imp.state]));

  const broken = await readBrokenInvariants(ctx, true);

  expect(states).toStrictEqual({
    alive: 'running',
    dead: 'stopped',
    'dead-fresh-snapshot': 'sleeping',
    'dead-old-snapshot': 'stopped',
    asleep: 'sleeping',
    'asleep-lost-snapshot': 'stopped',
    stopped: 'stopped',
    failed: 'error',
    'creating-live': 'error',
    'creating-dead': 'error',
  });

  expect(ctx.fake.stops).toContainEqual({ pid: orphanPid, graceful: false });
  expect(oldImps.listImps()).rejects.toThrow('this impd was replaced');
  expect(broken).toBeEmpty();
});

test('it starts the next impd past a creating imp whose VM will not stop', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const image = await ctx.images.resolveImage('ubuntu');

  const pid = ctx.fake.spawnOrphan();

  const creating = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'stuck', imageId: image.id, slot: 0, ip: '10.66.0.2' }),
  );

  await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating', pid });

  ctx.fake.queue('stop', 'fail');

  const reconciled = await waitForOutcome(ctx.restartImpd(), 10_000);
  const stuck = await readImpByName(ctx.db, 'stuck');
  const broken = await readBrokenInvariants(ctx, true);

  expect(reconciled).toBe('done');
  expect(stuck).toMatchObject({ state: 'error', pid });
  expect(ctx.fake.alive.has(pid)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it kills the VM of a creating imp that would not stop once a destroy lets go', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const image = await ctx.images.resolveImage('ubuntu');

  const pid = ctx.fake.spawnOrphan();

  const creating = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'stuck', imageId: image.id, slot: 0, ip: '10.66.0.2' }),
  );

  await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating', pid });

  ctx.fake.queue('stop', 'fail');

  await ctx.restartImpd();
  await ctx.client.imps.destroy({ name: 'stuck' });

  expect(ctx.fake.alive.has(pid)).toBeFalse();
});

test('it refuses a stop of an imp that is still being made', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const image = await ctx.images.resolveImage('ubuntu');

  await createImp(ctx.db, buildMockNewImp({ name: 'stuck', imageId: image.id }));

  expect(ctx.client.imps.stop({ name: 'stuck' })).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'creating', allowed: ['running', 'sleeping', 'error'] },
  });
});

test('it leaves every imp asleep for the next impd when impd stops with a wake under way', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'waking' });
  await ctx.client.imps.create({ name: 'running' });
  await ctx.client.imps.sleep({ name: 'waking' });

  const wakeGate = ctx.fake.hold('wake');
  const waking = ctx.client.imps.wake({ name: 'waking' });

  await wakeGate.reached;

  const stopping = ctx.imps.sleepAllImps();

  wakeGate.release();

  const woke = await waitForOutcome(waking, 10_000);
  const stopped = await waitForOutcome(stopping, 10_000);

  await ctx.restartImpd();

  const after = await listImps(ctx.db);
  const broken = await readBrokenInvariants(ctx, true);

  expect(woke).toBe('done');
  expect(stopped).toBe('done');
  expect(after.map((imp) => imp.state)).toStrictEqual(['sleeping', 'sleeping']);
  expect(ctx.fake.alive.size).toBe(0);
  expect(broken).toBeEmpty();
});

test('it wakes an imp that impd stopping left asleep on the next impd', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'waking' });
  await ctx.client.imps.sleep({ name: 'waking' });

  const wakeGate = ctx.fake.hold('wake');
  const waking = ctx.client.imps.wake({ name: 'waking' });

  await wakeGate.reached;

  const stopping = ctx.imps.sleepAllImps();

  wakeGate.release();

  await Promise.all([waking, stopping]);
  await ctx.restartImpd();

  const woken = await ctx.client.imps.wake({ name: 'waking' });

  expect(woken.state).toBe('running');
});

test('it re-adopts the VM of a boot under way once impd restarting in place waited for it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });

  const bootGate = ctx.fake.hold('boot');
  const starting = ctx.client.imps.start({ name: 'dev' });

  await bootGate.reached;

  const lifecycle = (async () => {
    await ctx.imps.waitForLifecycle();

    return ctx.fake.alive.size;
  })();

  bootGate.release();

  const vmsAtWaitEnd = await lifecycle;

  await starting;

  await ctx.restartImpd();

  const imp = await readImpByName(ctx.db, 'dev');
  const broken = await readBrokenInvariants(ctx, true);

  expect(vmsAtWaitEnd).toBe(1);
  expect(imp?.state).toBe('running');
  expect(ctx.fake.alive.has(imp?.pid ?? 0)).toBeTrue();
  expect(broken).toBeEmpty();
});

test('it leaves the next impd an error record when impd dies mid-create', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const bootGate = ctx.fake.hold('boot');
  const creating = ctx.client.imps.create({ name: 'dev' });

  await bootGate.reached;

  await ctx.restartImpd();

  bootGate.release();

  await waitFor(() => {
    expect(ctx.fake.countParkedCalls()).toBe(1);
  });

  const imp = await readImpByName(ctx.db, 'dev');

  expect(ctx.fake.alive.size).toBe(1);
  expect(Bun.peek.status(creating)).toBe('pending');
  expect(imp).toMatchObject({ state: 'error', pid: null });
});

test('it leaves consistent records after concurrent lifecycle calls on a few imps', async () => {
  const nameArb = fc.constantFrom('a', 'b', 'c', 'd');

  const opArb = fc.oneof(
    { arbitrary: fc.record({ kind: fc.constant('hold' as const), name: nameArb }), weight: 2 },
    fc.record({
      kind: fc.constantFrom(
        'create' as const,
        'sleep' as const,
        'wake' as const,
        'start' as const,
        'stop' as const,
        'restore' as const,
        'destroy' as const,
        'crash' as const,
        'outdate' as const,
      ),
      name: nameArb,
    }),
    fc.record({ kind: fc.constantFrom('enforce' as const, 'tick' as const, 'sigterm' as const) }),
  );

  const outcomeArb: fc.Arbitrary<VmOutcome> = fc.oneof(
    { arbitrary: fc.constant('ok' as const), weight: 2 },
    { arbitrary: fc.constantFrom('fail' as const, 'die' as const, 'hang' as const), weight: 1 },
  );

  const scriptArb = fc.record({
    boot: fc.array(outcomeArb, { maxLength: 4 }),
    wake: fc.array(outcomeArb, { maxLength: 4 }),
    sleep: fc.array(outcomeArb, { maxLength: 4 }),
    stop: fc.array(outcomeArb, { maxLength: 4 }),
    agentReady: fc.array(outcomeArb, { maxLength: 4 }),
  });

  const poolStack = new AsyncDisposableStack();

  onTestFinished(() => poolStack.disposeAsync());

  const pool = createTestImpdPool(poolStack, {
    impd: {
      env: {
        IMP_RAM_BUDGET_MIB: '900',
        IMP_DEFAULT_MEMORY_MIB: '512',
        IMP_BOOT_RESERVE_PERCENT: '80',
        IMP_WAKE_RESERVE_MIB: '410',
      },
    },
    prepareImpd: async (impd) => {
      await impd.createTestImage('ubuntu');
    },
  });

  await fc.assert(
    fc.asyncProperty(
      fc.scheduler(),
      fc.array(opArb, { minLength: 4, maxLength: 16 }),
      scriptArb,

      (scheduler, ops, script) => {
        const governorSleeps: Promise<{ readonly name: string; readonly held: boolean }>[] = [];

        return pool.withImpd(
          (lease) =>
            runWithStack(async (stack) => {
              const ctx = lease.ctx;
              const client = ctx.client;

              await client.imps.create({ name: 'c' });
              await client.checkpoints.create({ name: 'c', label: 'base' });
              await client.imps.sleep({ name: 'c' });
              await client.imps.create({ name: 'a' });
              await client.checkpoints.create({ name: 'a', label: 'base' });
              await client.imps.create({ name: 'b' });
              await client.checkpoints.create({ name: 'b', label: 'base' });

              ctx.fake.queue('boot', ...script.boot);
              ctx.fake.queue('wake', ...script.wake);
              ctx.fake.queue('sleep', ...script.sleep);
              ctx.fake.queue('stop', ...script.stop);
              ctx.fake.queue('agentReady', ...script.agentReady);
              ctx.fake.setPace(() => scheduler.schedule(Promise.resolve()));

              const runOp = async (op: (typeof ops)[number]): Promise<void> => {
                await match(op)
                  .returnType<unknown>()
                  .with({ kind: 'create' }, (create) => client.imps.create({ name: create.name }))
                  .with({ kind: 'sleep' }, (sleep) => client.imps.sleep({ name: sleep.name }))
                  .with({ kind: 'wake' }, (wake) => client.imps.wake({ name: wake.name }))
                  .with({ kind: 'start' }, (start) => client.imps.start({ name: start.name }))
                  .with({ kind: 'stop' }, (stop) => client.imps.stop({ name: stop.name }))
                  .with({ kind: 'restore' }, (restore) =>
                    client.checkpoints.restore({ name: restore.name, checkpoint: 'base' }),
                  )
                  .with({ kind: 'hold' }, (hold) =>
                    client.imps.hold({ name: hold.name, seconds: 30 }),
                  )
                  .with({ kind: 'destroy' }, (destroy) =>
                    client.imps.destroy({ name: destroy.name }),
                  )
                  .with({ kind: 'crash' }, async (crash) => {
                    const imp = await readImpByName(ctx.db, crash.name);

                    ctx.fake.alive.delete(imp?.pid ?? 0);
                  })
                  .with({ kind: 'outdate' }, async (outdate) => {
                    const imp = await readImpByName(ctx.db, outdate.name);

                    const paths = buildImpPaths(ctx.dataDir, imp?.id ?? '');
                    const meta = readSnapshotMeta(paths);

                    if (meta !== null) {
                      writeSnapshotMeta(paths, { ...meta, firecrackerVersion: 'v0.1.0' });
                    }
                  })
                  .with({ kind: 'enforce' }, () => ctx.governor.enforce())

                  .with({ kind: 'sigterm' }, () => {
                    lease.retire();

                    return ctx.imps.sleepAllImps();
                  })
                  .with({ kind: 'tick' }, () => {
                    ctx.advance(40_000);
                  })
                  .exhaustive();
              };

              const all = Promise.all(
                ops.map(async (op) => {
                  await scheduler.schedule(Promise.resolve());

                  return runOp(op).then(
                    () => null,
                    (error: unknown) => error,
                  );
                }),
              );

              stack.defer(async () => {
                ctx.fake.setPace(() => Promise.resolve());
                ctx.fake.clearQueues();
                ctx.fake.releaseHangs();

                await scheduler.waitIdle();

                await all;

                await ctx.imps.waitForLifecycle();
              });

              await waitFor(
                async () => {
                  await scheduler.waitIdle();

                  ctx.fake.releaseHangs();

                  if (Bun.peek.status(all) === 'pending') {
                    throw new Error('a call never settled');
                  }
                },
                { intervalMs: 0 },
              );

              const errors = await all;

              ctx.fake.setPace(() => Promise.resolve());
              ctx.fake.clearQueues();

              await ctx.imps.waitForLifecycle();

              const unknown = errors.filter(
                (error) =>
                  error !== null &&
                  !(
                    typeof error === 'object' &&
                    'code' in error &&
                    [
                      'NOT_FOUND',
                      'CONFLICT',
                      'INVALID_STATE',
                      'RAM_BUDGET_EXCEEDED',
                      'INTERNAL_SERVER_ERROR',
                      'SERVICE_UNAVAILABLE',
                    ].includes(String(error.code))
                  ),
              );

              const realErrors = ctx.rpcFailures.filter((error) => !(error instanceof StubVmError));

              const sleeps = await Promise.all(governorSleeps);

              const pinnedSleeps = sleeps.filter((sleep) => sleep.held);

              const quiescent = await readBrokenInvariants(ctx, false);

              await client.imps.list();

              const repaired = await readBrokenInvariants(ctx, true);
              const afterOps = await listImps(ctx.db);

              const busy = afterOps.filter(
                (imp) => ctx.imps.isImpBusy(imp.id) || ctx.imps.tracker.count(imp.id) > 0,
              );

              expect(unknown).toBeEmpty();
              expect(realErrors).toBeEmpty();
              expect(pinnedSleeps).toBeEmpty();
              expect(quiescent).toBeEmpty();
              expect(repaired).toBeEmpty();
              expect(busy).toBeEmpty();

              await ctx.governor.enforce();

              const usage = await ctx.governor.readUsage();
              const imps = await listImps(ctx.db);

              const runningUnheld = imps.filter(
                (imp) =>
                  imp.state === 'running' &&
                  (imp.holdUntil === null || imp.holdUntil.getTime() <= ctx.now()),
              );

              const sleepableOverBudget =
                usage.usedMib > ctx.config.ramBudgetMib ? runningUnheld : [];

              expect(sleepableOverBudget).toBeEmpty();
            }),
          {
            onLog: (message, impd) => {
              const asleep =
                /^impd: (?<name>\S+): asleep in \d+ms \((?:to make room for \S+|RAM over budget)\)/u.exec(
                  message,
                );

              const name = asleep?.groups?.['name'];

              if (name !== undefined) {
                const at = impd.now();

                governorSleeps.push(
                  readImpByName(impd.db, name).then((imp) => ({
                    name,
                    held: (imp?.holdUntil?.getTime() ?? 0) > at,
                  })),
                );
              }
            },
          },
        );
      },
    ),
    { numRuns: 25 },
  );
});

test('it boots a fixed imp on 2 MiB pages with huge pages on, and records them', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 4096, freeMib: 4096 }) } },
  });

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  expect(ctx.fake.bootPlans.map((plan) => plan.hugePages)).toStrictEqual(['2M']);
  expect(readVmIdentity(buildImpPaths(ctx.dataDir, created.id))?.hugePages).toBe('2M');
});

test('it boots an imp on host pages with huge pages off, and records none', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  const identity = readVmIdentity(buildImpPaths(ctx.dataDir, created.id));

  invariant(identity);

  expect(ctx.fake.bootPlans.map((plan) => plan.hugePages)).toStrictEqual(['None']);
  expect(identity).not.toContainKey('hugePages');
});

test('it refuses a 2M imp the huge page pool cannot hold before any VM starts', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 4096, freeMib: 128 }) } },
  });

  await ctx.createTestImage('ubuntu');

  expect(ctx.client.imps.create({ name: 'dev', memoryMib: 256 })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    message: expect.toInclude('not enough 2 MiB pages'),
  });

  expect(ctx.fake.bootPlans).toBeEmpty();
});

test('it refuses a 2M imp the pool could hold only with the pages an awake 2M imp has yet to take', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 4096, freeMib: 384 }) } },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'first', memoryMib: 256 });

  expect(ctx.client.imps.create({ name: 'second', memoryMib: 256 })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    message: expect.toInclude('256 MiB requested'),
  });

  expect(ctx.fake.bootPlans).toHaveLength(1);
});

test('it refuses a 2M imp on a host container with no userfaultfd device before any VM starts', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: {
      imps: {
        readHugePagePool: () => ({ totalMib: 4096, freeMib: 4096 }),
        probeUffdDevice: () => false,
      },
    },
  });

  await ctx.createTestImage('ubuntu');

  expect(ctx.client.imps.create({ name: 'dev', memoryMib: 256 })).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('needs /dev/userfaultfd'),
  });

  expect(ctx.fake.bootPlans).toBeEmpty();
});

test('it keeps a 2M imp asleep with its snapshot on a host container with no userfaultfd device', async () => {
  const device = { isThere: true };

  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: {
      imps: {
        readHugePagePool: () => ({ totalMib: 4096, freeMib: 4096 }),
        probeUffdDevice: () => device.isThere,
      },
    },
  });

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  await ctx.client.imps.sleep({ name: 'dev' });

  device.isThere = false;

  const waking = ctx.client.imps.wake({ name: 'dev' });

  expect(waking).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

  const after = await readImpByName(ctx.db, 'dev');

  expect(after?.state).toBe('sleeping');
  expect(readSnapshotMeta(buildImpPaths(ctx.dataDir, created.id))).not.toBeNull();
  expect(ctx.fake.wakePlans).toBeEmpty();
  expect(ctx.fake.bootPlans).toHaveLength(1);
});

test('it watches the page handler of each running imp a restarted impd adopts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  const running = await readImpByName(ctx.db, 'dev');

  invariant(running !== undefined && running.pid !== null);

  await ctx.restartImpd();

  expect(ctx.fake.handlerWatches).toStrictEqual([{ pid: running.pid, impId: running.id }]);
});

test('it wakes a 2M imp through its page handler with huge pages on', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 4096, freeMib: 4096 }) } },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakePlans.map((plan) => plan.hugePages)).toStrictEqual(['2M']);
});

test('it wakes a 2M imp on host pages with huge pages off, and records none', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, hugePages: '2M' });

  await ctx.client.imps.wake({ name: 'dev' });

  const identity = readVmIdentity(paths);

  invariant(identity);

  expect(ctx.fake.wakePlans.map((plan) => plan.hugePages)).toStrictEqual(['None']);
  expect(identity).not.toContainKey('hugePages');
});

test('it boots a fixed imp cold on the pool when its 4 KiB wake does not fit the RAM outside the pool', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');
  updateEnv('IMP_RAM_BUDGET_MIB', '4096');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 3968, freeMib: 3968 }) } },
  });

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);

  const { hugePages: _, ...onHostPages } = meta;

  writeSnapshotMeta(paths, onHostPages);

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakePlans).toBeEmpty();
  expect(ctx.fake.bootPlans.map((plan) => plan.hugePages)).toStrictEqual(['2M', '2M']);
});

test.each([
  ['an elastic imp', '2M', { memoryMib: 256, maxMemoryMib: 512 }, 512],
  ['an imp whose memory is no whole number of huge pages', '2M', { memoryMib: 257 }, 257],
  ['an imp on a host with huge pages off', 'off', { memoryMib: 256 }, 256],
])(
  'it keeps %s asleep with its snapshot, and boots it nowhere, when its wake does not fit the RAM outside the pool',
  async (_label, hugePages, shape, maxMib) => {
    updateEnv('IMP_HUGE_PAGES', hugePages);
    updateEnv('IMP_RAM_BUDGET_MIB', '4096');

    const stack = new AsyncDisposableStack();

    onTestFinished(() => stack.disposeAsync());

    const pool = { totalMib: 0, freeMib: 0 };

    const ctx = await startTestImpd(stack, {
      env: readImpEnv(),
      boundaries: { imps: { readHugePagePool: () => pool } },
    });

    await ctx.createTestImage('ubuntu');

    const created = await ctx.client.imps.create({ name: 'dev', ...shape });

    await ctx.client.imps.sleep({ name: 'dev' });

    Object.assign(pool, { totalMib: 3968, freeMib: 3968 });

    expect(ctx.client.imps.wake({ name: 'dev' })).rejects.toMatchObject({
      code: 'RAM_BUDGET_EXCEEDED',
      message: `the imp's memory, at its max (${String(maxMib)} MiB), is larger than the RAM budget outside the huge page pool (128 MiB)`,
    });

    expect(ctx.fake.wakePlans).toBeEmpty();
    expect(ctx.fake.bootPlans).toHaveLength(1);
    expect(existsSync(buildImpPaths(ctx.dataDir, created.id).snapshotMeta)).toBeTrue();
  },
);

test('it keeps a fixed imp asleep with its snapshot when the pool is too short for the cold boot its 4 KiB wake falls back to', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');
  updateEnv('IMP_RAM_BUDGET_MIB', '4096');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const pool = { totalMib: 3968, freeMib: 3968 };

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => pool } },
  });

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);

  const { hugePages: _, ...onHostPages } = meta;

  writeSnapshotMeta(paths, onHostPages);

  Object.assign(pool, { freeMib: 128 });

  expect(ctx.client.imps.wake({ name: 'dev' })).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    message: expect.toStartWith('not enough 2 MiB pages'),
  });

  expect(ctx.fake.wakePlans).toBeEmpty();
  expect(ctx.fake.bootPlans).toHaveLength(1);
  expect(existsSync(paths.snapshotMeta)).toBeTrue();
});

test('it wakes an imp on 4 KiB pages against the whole budget when the host pool has no pages', async () => {
  updateEnv('IMP_HUGE_PAGES', '2M');
  updateEnv('IMP_RAM_BUDGET_MIB', '4096');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const ctx = await startTestImpd(stack, {
    env: readImpEnv(),
    boundaries: { imps: { readHugePagePool: () => ({ totalMib: 0, freeMib: 0 }) } },
  });

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 512 });
  await ctx.client.imps.sleep({ name: 'dev' });

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakePlans).toHaveLength(1);
});

test('it wakes a host-page imp as it always has, with no huge pages asked for', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', memoryMib: 256 });
  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakePlans.map((plan) => plan.hugePages)).toStrictEqual([undefined]);
});
