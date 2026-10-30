import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
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
    owned: new Map(),
    leftovers: new Set(),
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

  const owned = new Map<string, string>();

  const step = await create.arrange({
    client: ctx.box.client,
    name: 'bench-taken',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
    leftovers: new Set(),
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

test('it gives up the name of an imp it removed, so it never claims the imp another run then makes under it', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const first = await ctx.box.client.imps.create({ name: 'bench-reused', image: 'base' });

  const create = BENCH_SCENARIOS.find((scenario) => scenario.name === 'create');

  invariant(create);

  const owned = new Map([['bench-reused', first.id]]);

  const step = await create.arrange({
    client: ctx.box.client,
    name: 'bench-reused',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
    leftovers: new Set(),
  });

  const ownedAfterRemoval = [...owned];

  await ctx.box.client.imps.create({ name: 'bench-reused', image: 'base' });

  const failure = await step().then(
    () => null,
    (error: unknown) => error,
  );

  expect(ownedAfterRemoval).toStrictEqual([]);
  expect(failure).toMatchObject({ code: 'CONFLICT' });
  expect(owned).toBeEmpty();
});

test('it refuses to arrange a wake on an imp of that name that the run did not create, and leaves it awake', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'bench-other', image: 'base' });

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  const arranging = wake.arrange({
    client: ctx.box.client,
    name: 'bench-other',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Map(),
    leftovers: new Set(),
  });

  const failure = await arranging.then(
    () => null,
    (error: unknown) => error,
  );

  const kept = await ctx.box.client.imps.get({ name: 'bench-other' });

  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty('message', 'bench-other exists, and this run did not create it');
  expect(kept.state).toBe('running');
});

test('it refuses to arrange a wake on an imp made under a name after the imp the run created there went, and leaves it awake', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const ours = await ctx.box.client.imps.create({ name: 'bench-swapped', image: 'base' });

  await ctx.box.client.imps.destroy({ name: 'bench-swapped' });
  await ctx.box.client.imps.create({ name: 'bench-swapped', image: 'base' });

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  const owned = new Map([['bench-swapped', ours.id]]);
  const leftovers = new Set<string>();

  const failure = await wake
    .arrange({
      client: ctx.box.client,
      name: 'bench-swapped',
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
      wait: () => Promise.resolve(),
      owned,
      leftovers,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const kept = await ctx.box.client.imps.get({ name: 'bench-swapped' });

  expect(failure).toHaveProperty('message', 'bench-swapped exists, and this run did not create it');
  expect(kept.state).toBe('running');
  expect(owned).toBeEmpty();
  expect([...leftovers]).toStrictEqual(['bench-swapped']);
});

test.each(['sleep', 'wake'])(
  'it refuses to go on with a %s arrange when another imp took the name while it waited, and leaves that imp awake',
  async (scenarioName) => {
    const ctx = await setupTest();

    const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.box.db, image);

    const scenario = BENCH_SCENARIOS.find((candidate) => candidate.name === scenarioName);

    invariant(scenario);

    const replace = async (): Promise<void> => {
      await ctx.box.client.imps.destroy({ name: 'bench-waited' });
      await ctx.box.client.imps.create({ name: 'bench-waited', image: 'base' });
    };

    const owned = new Map<string, string>();
    const leftovers = new Set<string>();

    const failure = await scenario
      .arrange({
        client: ctx.box.client,
        name: 'bench-waited',
        settings: { memoryMib: null, image: 'base', awakeMs: 0 },
        wait: replace,
        owned,
        leftovers,
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    const kept = await ctx.box.client.imps.get({ name: 'bench-waited' });

    expect(failure).toHaveProperty(
      'message',
      'bench-waited exists, and this run did not create it',
    );

    expect(kept.state).toBe('running');
    expect(owned).toBeEmpty();
    expect([...leftovers]).toStrictEqual(['bench-waited']);
  },
);

test('it fails a sleep arrange whose imp went while it waited, and gives up the name', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const sleep = BENCH_SCENARIOS.find((scenario) => scenario.name === 'sleep');

  invariant(sleep);

  const owned = new Map<string, string>();

  const arranged = sleep.arrange({
    client: ctx.box.client,
    name: 'bench-gone',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: async () => {
      await ctx.box.client.imps.destroy({ name: 'bench-gone' });
    },
    owned,
    leftovers: new Set(),
  });

  const failure = await arranged.then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toHaveProperty('message', 'bench-gone went while the bench waited');
  expect(owned).toBeEmpty();
});

test('it refuses to arrange a wake for an imp whose boot left it in error', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  ctx.box.fake.queue('boot', 'fail');

  await ctx.box.client.imps.create({ name: 'bench-broken', image: 'base' }).catch(() => null);

  const broken = await ctx.box.client.imps.get({ name: 'bench-broken' });

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  const arranged = wake.arrange({
    client: ctx.box.client,
    name: 'bench-broken',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Map([['bench-broken', broken.id]]),
    leftovers: new Set(),
  });

  expect(arranged).rejects.toThrowWithMessage(Error, 'bench-broken is error');
});

test("it claims no name when its create never reaches impd, so another run's imp under it stays", async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'bench-theirs', image: 'base' });

  const create = BENCH_SCENARIOS.find((scenario) => scenario.name === 'create');

  invariant(create);

  const owned = new Map<string, string>();

  const port = claimFreePorts(1).take();

  const step = await create.arrange({
    client: createImpClient({ url: `http://127.0.0.1:${String(port)}` }),
    name: 'bench-theirs',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
    leftovers: new Set(),
  });

  const failure = await step().then(
    () => null,
    (error: unknown) => error,
  );

  const theirs = await ctx.box.client.imps.get({ name: 'bench-theirs' });

  expect(failure).toMatchObject({ code: 'ECONNREFUSED' });
  expect(owned).toBeEmpty();
  expect(theirs.state).toBe('running');
});

test('it fails the arrange at the lookup, and claims no imp, when impd cannot be reached', () => {
  const sleep = BENCH_SCENARIOS.find((scenario) => scenario.name === 'sleep');

  invariant(sleep);

  const owned = new Map<string, string>();

  const port = claimFreePorts(1).take();

  const arranged = sleep.arrange({
    client: createImpClient({ url: `http://127.0.0.1:${String(port)}` }),
    name: 'bench-unreached',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned,
    leftovers: new Set(),
  });

  expect(arranged).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  expect(owned).toBeEmpty();
});

test("it boots a young-wake imp cold before each round's sleep, and its timed step only wakes it", async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const created = await ctx.box.client.imps.create({ name: 'bench-young', image: 'base' });

  await ctx.box.client.imps.sleep({ name: 'bench-young', force: true });

  const young = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake-young');

  invariant(young);

  const subject = {
    client: ctx.box.client,
    name: 'bench-young',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
    owned: new Map([['bench-young', created.id]]),
    leftovers: new Set<string>(),
  };

  const counts = (): { boots: number; wakes: number } => ({
    boots: ctx.box.fake.boots.length,
    wakes: ctx.box.fake.wakePlans.length,
  });

  const start = counts();

  const firstStep = await young.arrange(subject);

  const firstArranged = counts();

  const firstWoken = await firstStep();

  const firstTimed = counts();

  const secondStep = await young.arrange(subject);

  const secondArranged = counts();

  const secondWoken = await secondStep();

  const secondTimed = counts();

  expect(firstArranged.boots - start.boots).toBe(1);
  expect(firstTimed).toStrictEqual({ boots: firstArranged.boots, wakes: firstArranged.wakes + 1 });
  expect(firstWoken.state).toBe('running');
  expect(secondArranged.boots - firstTimed.boots).toBe(1);

  expect(secondTimed).toStrictEqual({
    boots: secondArranged.boots,
    wakes: secondArranged.wakes + 1,
  });

  expect(secondWoken.state).toBe('running');
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
    owned: new Map(),
    leftovers: new Set(),
  });

  const arranged = await ctx.box.client.imps.get({ name: 'bench-wake' });

  expect(arranged).toMatchObject({ state: 'sleeping', resources: { wakeCount: 1 } });
});
