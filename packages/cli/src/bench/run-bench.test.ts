import { expect, onTestFinished, test } from 'bun:test';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { watchEvents } from '@impz/client';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import invariant from 'tiny-invariant';
import { startImpdHost } from '../test-utils/start-impd-host';
import { BENCH_SCENARIOS } from './bench-scenarios';
import { runBench } from './run-bench';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const box = await startImpdHost(stack, { env: {} });

  const create = BENCH_SCENARIOS.find((scenario) => scenario.name === 'create');

  invariant(create);

  return { box, create };
}

test('it refuses a run whose imp names are taken, and leaves those imps alone', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'bench-c0ffee15a7e1-1-0', image: 'base' });

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {},
    },
    {
      runID: 'c0ffee15a7e1',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toThrowWithMessage(
    Error,
    'bench: imps named bench-c0ffee15a7e1-* already exist, so this run would not own them',
  );

  const imps = await ctx.box.client.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['bench-c0ffee15a7e1-1-0']);
});

test('it stops at a signal, fails the run, and removes the imps it made', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const stopper = new AbortController();

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {
        stopper.abort();
      },
      signal: stopper.signal,
    },
    {
      runID: 'deadbeef0042',
      scenarios: [ctx.create],
      levels: [1, 2],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toThrowWithMessage(
    Error,
    'bench: stopped by a signal, and removed the imps it made',
  );

  const imps = await ctx.box.client.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it fails a run whose event stream broke, since its impd figures are incomplete', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents: async (_client, options) => {
        await options.onOpen?.(1);

        throw new Error('the stream reset');
      },
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {},
    },
    {
      runID: '5ca1ab1e0007',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toThrowWithMessage(
    Error,
    "bench: impd's event stream failed, so its figures are incomplete",
  );
});

test('it fails a run whose event stream impd ended cleanly', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents: async (_client, options) => {
        await options.onOpen?.(1);
      },
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {},
    },
    {
      runID: '0ddba11c0de5',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toThrowWithMessage(
    Error,
    "bench: impd's event stream failed, so its figures are incomplete",
  );
});
