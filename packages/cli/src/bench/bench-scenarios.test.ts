import { expect, onTestFinished, test } from 'bun:test';
import { ORPCError, createImpClient } from '@impz/client';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
import invariant from 'tiny-invariant';
import { startImpdHost } from '../test-utils/start-impd-host';
import { BENCH_SCENARIOS } from './bench-scenarios';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const box = await startImpdHost(stack, { env: {} });

  return { box };
}

test('it restores the checkpoint that the restore arrange found, with no lookup in its timed step', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const restore = BENCH_SCENARIOS.find((scenario) => scenario.name === 'restore');

  invariant(restore);

  const step = await restore.arrange({
    client: ctx.box.client,
    name: 'bench-restore',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Set(),
  });

  const [arranged] = await ctx.box.client.checkpoints.list({ name: 'bench-restore' });

  invariant(arranged);

  await ctx.box.client.checkpoints.delete({ name: 'bench-restore', checkpoint: arranged.id });
  await ctx.box.client.checkpoints.create({ name: 'bench-restore', label: 'bench' });

  expect(step()).rejects.toMatchObject({ code: 'NOT_FOUND' });
});

test('it never removes or claims an imp of that name that the run did not make', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'bench-taken', image: 'base' });

  const create = BENCH_SCENARIOS.find((scenario) => scenario.name === 'create');

  invariant(create);

  const owned = new Set<string>();

  const step = await create.arrange({
    client: ctx.box.client,
    name: 'bench-taken',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
  });

  const failure = await step().then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({ code: 'CONFLICT' });
  expect(owned).toBeEmpty();

  const kept = await ctx.box.client.imps.get({ name: 'bench-taken' });

  expect(kept.name).toBe('bench-taken');
});

test('it refuses to arrange a wake for an imp whose boot left it in error', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  ctx.box.fake.queue('boot', 'fail');

  await ctx.box.client.imps.create({ name: 'bench-broken', image: 'base' }).catch(() => null);

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  const arranged = wake.arrange({
    client: ctx.box.client,
    name: 'bench-broken',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Set(['bench-broken']),
  });

  expect(arranged).rejects.toThrowWithMessage(Error, 'bench-broken is error');
});

test('it fails the arrange at the lookup, and claims no imp, when impd cannot be reached', () => {
  const sleep = BENCH_SCENARIOS.find((scenario) => scenario.name === 'sleep');

  invariant(sleep);

  const owned = new Set<string>();

  const port = claimFreePorts(1).take();

  const arranged = sleep.arrange({
    client: createImpClient({ url: `http://127.0.0.1:${String(port)}` }),
    name: 'bench-unreached',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
  });

  expect(arranged).rejects.not.toBeInstanceOf(ORPCError);
  expect(owned).toBeEmpty();
});

test('it boots a young-wake imp cold again before it sleeps for the timed wake', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'bench-young', image: 'base' });
  await ctx.box.client.imps.sleep({ name: 'bench-young', force: true });

  const young = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake-young');

  invariant(young);

  await young.arrange({
    client: ctx.box.client,
    name: 'bench-young',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Set(['bench-young']),
  });

  const arranged = await ctx.box.client.imps.get({ name: 'bench-young' });

  expect(ctx.box.fake.boots.map((boot) => boot.hostname)).toStrictEqual([
    'bench-young',
    'bench-young',
  ]);

  expect(arranged.state).toBe('sleeping');
});

test('it times the wake of an imp that has woken before, even on its first round', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  await wake.arrange({
    client: ctx.box.client,
    name: 'bench-wake',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Set(),
  });

  const arranged = await ctx.box.client.imps.get({ name: 'bench-wake' });

  expect(arranged).toMatchObject({ state: 'sleeping', resources: { wakeCount: 1 } });
});
