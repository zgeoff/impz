import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Imp } from '@impz/api';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import invariant from 'tiny-invariant';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { readBrokenInvariants } from '../../../testing/imps/read-broken-invariants';
import { waitForOutcome } from '../../../testing/imps/wait-for-outcome';
import { startTestImpd } from '../../../testing/start-test-impd';
import type { TestImpdOptions } from '../../../testing/start-test-impd';
import { buildStubCpuCgroups } from '../../../testing/vm/build-stub-cpu-cgroups';
import { STUB_AGENT_VERSION } from '../../../testing/vm/build-stub-vmm';
import { createImp, readImpByName } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import { readSnapshotMeta, writeSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import { buildImpPaths, buildSystemDrivePath } from '../../vm/storage/data-layout';

async function setupTest(options: Pick<TestImpdOptions, 'cgroups'> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { ...options, env: readImpEnv() });

  return Object.assign(harness, {
    oldDrive: harness.readIdentity().systemDrive,
  });
}

test('it keeps every imp through an agent upgrade, and asleep on the kept drive', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  for (const name of ['awake', 'held', 'asleep', 'off']) {
    await ctx.client.imps.create({ name });
  }

  await ctx.client.imps.hold({ name: 'held', seconds: 3600 });
  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.client.imps.stop({ name: 'off' });

  ctx.fake.queue('boot', 'fail');

  const breaking = ctx.client.imps.create({ name: 'broken' });

  const broken = await waitForOutcome(breaking, 10_000);
  const image = await ctx.images.resolveImage('ubuntu');

  const creating = await createImp(
    ctx.db,
    buildMockNewImp({ name: 'creating', imageId: image.id, slot: 9, ip: '10.66.0.38' }),
  );

  await updateImpState(ctx.db, creating.id, { reason: 'failed', state: 'creating' });

  const oldDrive = ctx.readIdentity().systemDrivePath;

  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const pruned = ctx.logs.filter((line) =>
    line.startsWith('INFO impd.storage removed system drive'),
  );

  const imps = await ctx.client.imps.list();

  const listed = new Map(imps.map((imp) => [imp.name, imp]));

  expect(broken).toBe('failed');

  expect(breaking).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'Internal server error',
  });

  expect(pruned).toBeEmpty();
  expect(existsSync(oldDrive)).toBeTrue();
  expect(listed.get('awake')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('held')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('asleep')).toMatchObject({ state: 'sleeping', outdated: ['agent'] });
  expect(listed.get('off')?.state).toBe('stopped');
  expect(listed.get('broken')?.state).toBe('error');
  expect(listed.get('creating')?.state).toBe('error');
  expect(imps).toSatisfyAll((imp: Readonly<Imp>) => imp.coldBootReason === undefined);
});

test('it wakes a kept imp on the old agent after an agent upgrade', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const awake = await ctx.client.imps.create({ name: 'awake' });
  const asleep = await ctx.client.imps.create({ name: 'asleep' });

  writeFileSync(buildImpPaths(ctx.dataDir, awake.id).disk, 'disk of awake');
  writeFileSync(buildImpPaths(ctx.dataDir, asleep.id).disk, 'disk of asleep');

  await ctx.client.imps.sleep({ name: 'asleep' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await ctx.client.imps.wake({ name: 'asleep' });

  const wokenDrive = readVmIdentity(buildImpPaths(ctx.dataDir, asleep.id))?.systemDrive;

  const invariants = await readBrokenInvariants(ctx, true);

  expect(ctx.fake.wakes).toHaveLength(wakesBefore + 1);
  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(wokenDrive).toBe(ctx.oldDrive);
  expect(readFileSync(buildImpPaths(ctx.dataDir, asleep.id).disk, 'utf8')).toBe('disk of asleep');
  expect(readFileSync(buildImpPaths(ctx.dataDir, awake.id).disk, 'utf8')).toBe('disk of awake');
  expect(invariants).toBeEmpty();
});

test('it starts a stopped imp on the new agent after an agent upgrade', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const off = await ctx.client.imps.create({ name: 'off' });

  writeFileSync(buildImpPaths(ctx.dataDir, off.id).disk, 'disk of off');

  await ctx.client.imps.stop({ name: 'off' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const started = await ctx.client.imps.start({ name: 'off' });

  const startedDrive = readVmIdentity(buildImpPaths(ctx.dataDir, off.id))?.systemDrive;

  const invariants = await readBrokenInvariants(ctx, true);

  expect(started.state).toBe('running');
  expect(started.outdated).toBeUndefined();
  expect(startedDrive).toBe('d2'.repeat(32));
  expect(readFileSync(buildImpPaths(ctx.dataDir, off.id).disk, 'utf8')).toBe('disk of off');
  expect(invariants).toBeEmpty();
});

test('it says why a sleeping imp whose drive is gone boots cold', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const asleep = await ctx.client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: `its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`,
  });
});

test('it boots cold a sleeping imp whose drive is gone, and keeps its disk', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  writeFileSync(paths.disk, 'disk of dev');

  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.fake.wakes).toHaveLength(wakesBefore);
  expect(woken.state).toBe('running');
  expect(woken.coldBootReason).toBe(`its agent drive ${ctx.oldDrive.slice(0, 12)} is gone`);
  expect(woken.outdated).toBeUndefined();
  expect(readFileSync(paths.disk, 'utf8')).toBe('disk of dev');
});

test('it wakes a jailed imp with its memory on the old drive after an agent upgrade', async () => {
  updateEnv('IMP_JAILER', 'true');

  const ctx = await setupTest({
    cgroups: buildStubCpuCgroups({ isMemoryEnforced: true }).cgroups,
  });

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  const wokenDrive = readVmIdentity(buildImpPaths(ctx.dataDir, created.id))?.systemDrive;

  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
  expect(wokenDrive).toBe(ctx.oldDrive);
});

test('it marks a VM re-adopted after a drive change as on the old agent', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const pruned = ctx.logs.filter((line) =>
    line.startsWith('INFO impd.storage removed system drive'),
  );

  const awake = await ctx.client.imps.get({ name: 'dev' });

  expect(pruned).toBeEmpty();
  expect(awake.outdated).toStrictEqual(['agent']);
});

test('it records in the snapshot the drive a re-adopted VM booted from', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  const oldDrivePath = ctx.readIdentity().systemDrivePath;

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));
  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(buildImpPaths(ctx.dataDir, created.id))).toMatchObject({
    systemDrive: ctx.oldDrive,
    systemDrivePath: oldDrivePath,
  });
});

test('it wakes a re-adopted VM from the old drive its snapshot names', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const upgraded = ctx.client;

  await upgraded.imps.sleep({ name: 'dev' });

  const woken = await upgraded.imps.wake({ name: 'dev' });

  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it keeps the newer drive on a downgrade while a snapshot names it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive(ctx.oldDrive));

  const pruned = ctx.logs.filter((line) =>
    line.startsWith('INFO impd.storage removed system drive'),
  );

  expect(pruned).toBeEmpty();
});

test('it wakes on a downgrade the snapshot the newer drive wrote', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive(ctx.oldDrive));

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  const wokenDrive = readVmIdentity(buildImpPaths(ctx.dataDir, created.id))?.systemDrive;

  expect(woken).toMatchObject({ state: 'running', outdated: ['agent'] });
  expect(wokenDrive).toBe('d2'.repeat(32));
});

test('it prunes the newer drive once nothing names it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.client.imps.start({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive(ctx.oldDrive));
  await ctx.client.imps.wake({ name: 'dev' });
  await ctx.client.imps.stop({ name: 'dev' });
  await ctx.restartImpd(ctx.createSystemDrive(ctx.oldDrive));

  const pruned = ctx.logs.filter((line) =>
    line.startsWith('INFO impd.storage removed system drive'),
  );

  expect(pruned).toStrictEqual([
    `INFO impd.storage removed system drive ${'d2'.repeat(32)}.squashfs: no imp uses it`,
  ]);
});

test('it says a snapshot from an older impd boots cold', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);

  const { systemDrivePath: _path, agentVersion: _agent, ...legacy } = meta;

  writeSnapshotMeta(paths, { ...legacy, systemDrive: '9f3c51a07e2b44d1' });

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const asleep = await ctx.client.imps.get({ name: 'dev' });

  expect(asleep).toMatchObject({
    state: 'sleeping',
    coldBootReason: 'the snapshot is from an older impd',
  });
});

test('it boots cold once a snapshot from an older impd, and keeps the disk', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  writeFileSync(paths.disk, 'disk of dev');

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  const { systemDrivePath: _path, agentVersion: _agent, ...legacy } = meta;

  writeSnapshotMeta(paths, { ...legacy, systemDrive: '9f3c51a07e2b44d1' });

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toBeEmpty();
  expect(readFileSync(paths.disk, 'utf8')).toBe('disk of dev');
});

test('it boots cold when the woken agent is not the one the snapshot recorded', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.9' });

  const woken = await ctx.client.imps.wake({ name: 'dev' });

  expect(woken).toMatchObject({
    state: 'running',
    coldBootReason: `the agent answered as ${STUB_AGENT_VERSION}, not 0.0.9`,
  });

  expect(ctx.fake.wakes).toHaveLength(1);
  expect(ctx.fake.alive.size).toBe(1);
});

test('it keeps the disk to a woken VM with the wrong agent that will not stop', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);
  writeSnapshotMeta(paths, { ...meta, agentVersion: '0.0.9' });

  ctx.fake.queue('stop', 'fail');

  const waking = ctx.client.imps.wake({ name: 'dev' });

  const outcome = await waitForOutcome(waking, 10_000);
  const imp = await readImpByName(ctx.db, 'dev');
  const invariants = await readBrokenInvariants(ctx, true);

  expect(outcome).toBe('failed');

  expect(waking).rejects.toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    message: 'Internal server error',
  });

  expect(ctx.fake.alive.size).toBe(1);
  expect(ctx.fake.wakes).toHaveLength(1);
  expect(imp).toMatchObject({ state: 'error', pid: ctx.fake.wakes[0] });
  expect(invariants).toBeEmpty();
});

test('it runs a boot whose vm.json cannot be written, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.stop({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  rmSync(paths.vmIdentity);
  mkdirSync(`${paths.vmIdentity}/blocked`, { recursive: true });

  const started = await ctx.client.imps.start({ name: 'dev' });

  expect(started.state).toBe('running');

  expect(ctx.logs).toSatisfyAny((line: string) =>
    line.startsWith('WARNING impd.imps imp=dev could not write vm.json'),
  );
});

test('it marks a VM booted by an impd that kept no identity as from an older impd', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  rmSync(buildImpPaths(ctx.dataDir, created.id).vmIdentity);

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const awake = await ctx.client.imps.get({ name: 'dev' });

  expect(awake.outdated).toStrictEqual(['impd']);
});

test('it says the next wake of a VM booted by an impd that kept no identity boots cold', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  rmSync(buildImpPaths(ctx.dataDir, created.id).vmIdentity);

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const upgraded = ctx.client;

  await upgraded.imps.sleep({ name: 'dev' });

  const asleep = await upgraded.imps.get({ name: 'dev' });

  expect(asleep.coldBootReason).toBe('the snapshot is from an older impd');
});

test('it clears on a sleep the reason the last boot was cold', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  rmSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive));

  const upgraded = ctx.client;

  await upgraded.imps.wake({ name: 'dev' });
  await upgraded.imps.sleep({ name: 'dev' });

  const woken = await upgraded.imps.wake({ name: 'dev' });

  expect(woken.coldBootReason).toBeUndefined();
  expect(ctx.fake.wakes).toHaveLength(1);
});

test('it never removes a drive in use when the data dir moved, by its file name', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const paths = buildImpPaths(ctx.dataDir, created.id);
  const meta = readSnapshotMeta(paths);

  invariant(meta);

  writeSnapshotMeta(paths, {
    ...meta,
    systemDrivePath: `/old/imp/system/drives/${ctx.oldDrive}.squashfs`,
  });

  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  const pruned = ctx.logs.filter((line) =>
    line.startsWith('INFO impd.storage removed system drive'),
  );

  expect(pruned).toBeEmpty();
  expect(existsSync(buildSystemDrivePath(ctx.dataDir, ctx.oldDrive))).toBeTrue();
});

test('it counts in system.info the imps an agent upgrade left outdated or without a snapshot', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'kept' });

  const lost = await ctx.client.imps.create({ name: 'lost' });

  await ctx.client.imps.create({ name: 'off' });
  await ctx.client.imps.stop({ name: 'off' });
  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  rmSync(buildImpPaths(ctx.dataDir, lost.id).snapshotDir, { recursive: true });

  const info = await ctx.client.system.info();

  expect(info.bootStatus).toStrictEqual({
    coldBoots: 1,
    outdated: { firecracker: 0, kernel: 0, agent: 1 },
  });
});

test('it boots cold a sleeping imp whose snapshot is gone after an agent upgrade', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const lost = await ctx.client.imps.create({ name: 'lost' });

  await ctx.imps.sleepAllImps();
  await ctx.restartImpd(ctx.createSystemDrive('d2'.repeat(32)));

  rmSync(buildImpPaths(ctx.dataDir, lost.id).snapshotDir, { recursive: true });

  const wakesBefore = ctx.fake.wakes.length;

  const woken = await ctx.client.imps.wake({ name: 'lost' });

  expect(woken.state).toBe('running');
  expect(ctx.fake.wakes).toHaveLength(wakesBefore);
});

test('it counts in system.info a running imp on an older firecracker as a cold boot to come', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.restartImpd({ ...ctx.readIdentity(), firecrackerVersion: 'v1.18.0' });

  const info = await ctx.client.system.info();

  expect(info.bootStatus).toStrictEqual({
    coldBoots: 1,
    outdated: { firecracker: 1, kernel: 0, agent: 0 },
  });
});

test('it says a running imp on an older firecracker boots cold after its sleep', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.restartImpd({ ...ctx.readIdentity(), firecrackerVersion: 'v1.18.0' });

  const client = ctx.client;

  await client.imps.sleep({ name: 'dev' });

  const asleep = await client.imps.get({ name: 'dev' });

  expect(asleep.coldBootReason).toBe('firecrackerVersion changed (v1.17.0 → v1.18.0)');
});
