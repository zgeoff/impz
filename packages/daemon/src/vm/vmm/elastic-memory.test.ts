import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import invariant from 'tiny-invariant';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { startTestImpd } from '../../../testing/start-test-impd';
import type { TestImpdOptions } from '../../../testing/start-test-impd';
import { buildStubCpuCgroups } from '../../../testing/vm/build-stub-cpu-cgroups';
import { readSnapshotMeta } from '../sleep/snapshot-meta';
import { buildImpPaths } from '../storage/data-layout';
import { buildMemoryMax, createCpuCgroups } from './cpu-cgroups';
import {
  getLowMib,
  getRegionMib,
  getSpareTotalMib,
  getStructPageMib,
  resolveMaxMemoryMib,
  toWholeBlocks,
} from './elastic-memory';

async function setupTest(options: Pick<TestImpdOptions, 'cgroups'> = {}) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const cgroups = buildStubCpuCgroups();
  const clock = buildStubClock({ startMs: Date.UTC(2026, 0, 1) });

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    cgroups: options.cgroups ?? cgroups.cgroups,
    boundaries: { imps: { now: clock.now, sleep: clock.sleep } },
  });

  // Object.assign keeps the harness's getters live, where a spread reads each of them once.
  return Object.assign(harness, { cgroups });
}

test.each([
  ['an imp that does not grow', 512, 512, 0],
  ['growth of exactly one slot', 512, 640, 128],
  ['growth past a slot, rounded up to whole slots', 512, 700, 256],
])('#findRegionMib gives %s its region', (_label, memoryMib, maxMemoryMib, regionMib) => {
  expect(getRegionMib(memoryMib, maxMemoryMib)).toBe(regionMib);
});

test.each([
  ['128 MiB for a small guest', 512, 128],
  ['15 % of a large guest', 2000, 300],
])('#findLowMib sets the grow mark at %s', (_label, totalMib, lowMib) => {
  expect(getLowMib(totalMib)).toBe(lowMib);
});

test('#findSpareTotalMib leaves a small guest a step more than 128 MiB free', () => {
  expect(getSpareTotalMib(200)).toBe(584);
});

test('#findSpareTotalMib leaves a large guest a step more than 15 % of it free', () => {
  expect(getSpareTotalMib(2000)).toBe(2655);
});

test('#findStructPageMib costs 16 MiB of struct pages per GiB plugged, rounded up', () => {
  expect(getStructPageMib(3072)).toBe(48);
});

test('#toWholeBlocks rounds up to whole 2 MiB blocks', () => {
  expect(toWholeBlocks(1033)).toBe(1034);
});

test('#resolveMaxMemoryMib gives an imp that asks for no max its memory', () => {
  expect(resolveMaxMemoryMib(512, undefined)).toBe(512);
});

test('#resolveMaxMemoryMib takes a max up to 4 times the memory', () => {
  expect(resolveMaxMemoryMib(512, 2048)).toBe(2048);
});

test('#resolveMaxMemoryMib refuses a max below the memory as a bad request', () => {
  expect(Promise.try(() => resolveMaxMemoryMib(512, 256))).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'the max memory (256 MiB) is less than the memory (512 MiB)',
  });
});

test('#resolveMaxMemoryMib refuses a max past 4 times the memory as a bad request', () => {
  expect(Promise.try(() => resolveMaxMemoryMib(512, 2050))).rejects.toMatchObject({
    code: 'BAD_REQUEST',
  });
});

test('#resolveMaxMemoryMib says to raise the memory with a max past 4 times it', () => {
  expect(() => resolveMaxMemoryMib(512, 2050)).toThrow(
    'the max memory (2050 MiB) is more than 4 × the memory (2048 MiB)',
  );
});

test('it refuses a max above 4 × the memory at create', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const creating = ctx.client.imps.create({ name: 'big', memoryMib: 256, maxMemoryMib: 1025 });

  expect(creating).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(creating).rejects.toThrow('more than 4 × the memory (1024 MiB)');
});

test('it refuses a max below the memory at create', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  expect(
    ctx.client.imps.create({ name: 'small', memoryMib: 512, maxMemoryMib: 256 }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it creates an imp with a max of 4 × its memory', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  expect(created).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it creates an imp with no max when the create asks for none', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  expect(created).not.toHaveProperty('maxMemoryMib');
});

test('it forks an imp with the max of its source', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const fork = await ctx.client.imps.fork({ source: 'dev', name: 'twin' });

  expect(fork).toMatchObject({ memoryMib: 256, maxMemoryMib: 1024 });
});

test('it never boots an imp whose max is larger than the whole RAM budget', async () => {
  updateEnv('IMP_RAM_BUDGET_MIB', '1024');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const creating = ctx.impd.imps.createImp({ name: 'big', memoryMib: 512, maxMemoryMib: 2048 });

  expect(creating).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });
  expect(creating).rejects.toThrow('at its max (2048 MiB)');
});

test('it unplugs on a sleep what the guest can spare', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 100,
    unplugFloorMib: 256,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ memoryMib: 256, pluggedMib: 256 });
  expect(ctx.fake.guestMemory.get(paths.directory)?.requestedMib).toBe(256);
  expect(ctx.logs).toSatisfyAny((line: string) => line.includes('256 MiB plugged'));
});

test('it allows on a wake what the guest kept plugged at its sleep', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 100,
    unplugFloorMib: 256,
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(
    ctx.cgroups.calls.filter((call) => call.startsWith(`memory ${created.id} `)),
  ).toStrictEqual([`memory ${created.id} 256`, `memory ${created.id} 512`]);
});

test('it records what a plug under way asked for at a sleep', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 256,
    requestedMib: 512,
    usedMib: 400,
    unplugFloorMib: 0,
  });

  await ctx.client.imps.sleep({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });
});

test('it allows on a wake what a plug under way at the sleep asked for', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 256,
    requestedMib: 512,
    usedMib: 400,
    unplugFloorMib: 0,
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(ctx.cgroups.calls.findLast((call) => call.startsWith(`memory ${created.id} `))).toBe(
    `memory ${created.id} 768`,
  );
});

test('it sleeps an imp that does not grow without asking its guest', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'plain', memoryMib: 256 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  await ctx.client.imps.sleep({ name: 'plain' });

  const meta = readSnapshotMeta(paths);

  invariant(meta);

  expect(ctx.fake.guestMemory.has(paths.directory)).toBeFalse();
  expect(meta).not.toHaveProperty('pluggedMib');
});

test('it raises memory.max with a grow of the guest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  ctx.fake.agent.version = '0.17.0';

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.impd.governed.memory.runTick();

  expect(ctx.fake.guestMemory.get(paths.directory)?.pluggedMib).toBe(256);

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(512));
});

test('it sets memory.max to the memory at the first boot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(256));
});

test('it consumes the snapshot meta of an elastic imp on a wake', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  await ctx.client.imps.sleep({ name: 'dev' });
  await ctx.client.imps.wake({ name: 'dev' });

  expect(readSnapshotMeta(paths)).toBeNull();
});

test('it keeps memory.max at the plugged size across a sleep and a wake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  ctx.fake.agent.version = '0.17.0';

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.impd.governed.memory.runTick();
  await ctx.impd.imps.sleepImp('dev');
  await ctx.impd.imps.wakeImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(512));
});

test('it sets memory.max back to the memory on a cold boot after a stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  ctx.fake.agent.version = '0.17.0';

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.impd.governed.memory.runTick();
  await ctx.impd.imps.stopImp('dev');
  await ctx.impd.imps.startImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(256));
});

test('it allows on adopt after a restart what the guest holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  await ctx.restartImpd();

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(768));
});

test('it keeps the adopted memory.max through a sleep before any tick after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'imp-elastic-cgroups-'));

  await mkdir(join(root, 'imps'));
  await writeFile(join(root, 'imps', 'cgroup.subtree_control'), 'cpu memory\n');

  const ctx = await setupTest({ cgroups: createCpuCgroups({ root, log: () => {} }) });

  await ctx.createTestImage('ubuntu');

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const created = await ctx.impd.imps.createImp({
    name: 'dev',
    memoryMib: 256,
    maxMemoryMib: 1024,
  });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 512,
    requestedMib: 512,
    usedMib: 700,
    unplugFloorMib: 512,
  });

  const restarted = await ctx.restartImpd();

  await restarted.imps.sleepImp('dev');

  const memoryMax = await readFile(join(root, 'imps', created.id, 'memory.max'), 'utf8');

  expect(memoryMax).toBe(buildMemoryMax(768));
  expect(readSnapshotMeta(paths)).toMatchObject({ pluggedMib: 512 });
});

test('it never grows an elastic imp whose agent predates elastic memory, and logs why', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.client.imps.create({ name: 'dev', memoryMib: 256, maxMemoryMib: 1024 });

  const paths = buildImpPaths(ctx.dataDir, created.id);

  ctx.fake.guestMemory.set(paths.directory, {
    baseMib: 256,
    pluggedMib: 0,
    requestedMib: 0,
    usedMib: 200,
    unplugFloorMib: 0,
  });

  await ctx.impd.governed.memory.runTick();

  expect(ctx.fake.guestMemory.get(paths.directory)?.pluggedMib).toBe(0);

  expect(ctx.logs).toSatisfyAny((line: string) =>
    /dev: memory low, not grown.*the imp's agent has no elastic memory/u.test(line),
  );
});
