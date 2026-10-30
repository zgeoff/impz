import { expect, onTestFinished, test } from 'bun:test';
import { setImmediate as setImmediatePromise } from 'node:timers/promises';
import { EVENT_VERSION } from '@impz/api';
import type { Imp } from '@impz/api';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { createImpClient, watchEvents } from '@impz/client';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import invariant from 'tiny-invariant';
import { buildStubEventFeed } from '../test-utils/build-stub-event-feed';
import { makeLostAnswerFetch } from '../test-utils/make-lost-answer-fetch';
import { makeStubEventStream } from '../test-utils/make-stub-event-stream';
import { startImpdHost } from '../test-utils/start-impd-host';
import { BENCH_SCENARIOS } from './bench-scenarios';
import type { BenchScenario } from './bench-scenarios';
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

test.each([
  ['a timeout', new DOMException('The operation timed out.', 'TimeoutError')],
  ['a reset', Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' })],
])(
  'it leaves the imp under a name whose create answer %s lost, and reports it',
  async (_label, lost) => {
    const ctx = await setupTest();

    const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.box.db, image);

    const client = createImpClient({
      url: 'http://impd.test',
      token: ctx.box.rootToken,
      fetch: makeLostAnswerFetch(ctx.box.sendRequest, '/rpc/imps/create', lost),
    });

    const lines: string[] = [];

    const results = await runBench(
      {
        client,
        watchEvents,
        now: () => performance.now(),
        wait: () => setImmediatePromise(),
        onProgress: (line) => {
          lines.push(line);
        },
      },
      {
        runID: 'c0ffee00a1b2',
        scenarios: [ctx.create],
        levels: [1],
        samples: 1,
        settings: { memoryMib: null, image: 'base', awakeMs: 0 },
      },
    );

    const imps = await ctx.box.client.imps.list();

    expect(results.map((result) => result.failures)).toStrictEqual([{ ERROR: 1 }]);
    expect(imps.map((imp) => imp.name)).toStrictEqual(['bench-c0ffee00a1b2-1-0']);

    expect(lines).toContain(
      'bench: left bench-c0ffee00a1b2-1-0 on the host: nothing proves the imp under that name is one this run created',
    );
  },
);

test('it leaves the imp made under a name after a destroy whose answer was lost, and reports it', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const reset = Object.assign(new TypeError('socket closed'), { code: 'ECONNRESET' });

  const replace = () =>
    ctx.box.client.imps.create({ name: 'bench-0dd0bead0001-1-0', image: 'base' });

  const lostFetch = makeLostAnswerFetch(ctx.box.sendRequest, '/rpc/imps/destroy', reset, replace);

  const client = createImpClient({
    url: 'http://impd.test',
    token: ctx.box.rootToken,
    fetch: lostFetch,
  });

  const lines: string[] = [];

  const failure = await runBench(
    {
      client,
      watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: (line) => {
        lines.push(line);
      },
    },
    {
      runID: '0dd0bead0001',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  ).then(
    () => null,
    (error: unknown) => error,
  );

  const imps = await ctx.box.client.imps.list();

  expect(failure).toBeInstanceOf(AggregateError);
  expect(imps.map((imp) => imp.state)).toStrictEqual(['running']);

  expect(lines).toContain(
    'bench: left bench-0dd0bead0001-1-0 on the host: nothing proves the imp under that name is one this run created',
  );
});

test('it fails a run whose event stream broke, since its impd figures are incomplete', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents: makeStubEventStream(new Error('the stream reset')),
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

test('it counts an arrange whose create failed under its code, times no step, and leaves and reports the imp it cannot prove it made', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  ctx.box.fake.queue('boot', 'fail');

  const wake = BENCH_SCENARIOS.find((scenario) => scenario.name === 'wake');

  invariant(wake);

  const lines: string[] = [];

  const results = await runBench(
    {
      client: ctx.box.client,
      watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: (line) => {
        lines.push(line);
      },
    },
    {
      runID: 'a11ce0000b0b',
      scenarios: [wake],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  const imps = await ctx.box.client.imps.list();

  expect(results).toStrictEqual([
    {
      scenario: 'wake',
      concurrency: 1,
      samples: 0,
      failures: { 'arrange INTERNAL_SERVER_ERROR': 1 },
      impdMs: null,
      memFileMib: null,
      latencyMs: null,
    },
  ]);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['bench-a11ce0000b0b-1-0']);

  expect(lines).toContain(
    'bench: left bench-a11ce0000b0b-1-0 on the host: nothing proves the imp under that name is one this run created',
  );
});

test('it fails with the stream error and makes no imp when the event stream never opens', async () => {
  const ctx = await setupTest();

  const streamFailure = new Error('connect ECONNREFUSED 127.0.0.1');

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents: () => Promise.reject(streamFailure),
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {},
    },
    {
      runID: 'b0bca7000001',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toBe(streamFailure);

  const imps = await ctx.box.client.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it fails a run whose event stream impd ended cleanly', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents: makeStubEventStream(null),
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

test('it fails a run that could not remove an imp it made, names it, and reports each failed removal', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  ctx.box.fake.queue('stop', 'fail', 'fail');

  const lines: string[] = [];

  const run = runBench(
    {
      client: ctx.box.client,
      watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: (line) => {
        lines.push(line);
      },
    },
    {
      runID: 'feedface0001',
      scenarios: [ctx.create],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    },
  );

  expect(run).rejects.toThrowWithMessage(
    AggregateError,
    'bench: could not remove bench-feedface0001-1-0, so they are left on the host',
  );

  expect(lines.filter((line) => line.startsWith('bench: could not remove'))).toHaveLength(2);
});

test("it takes impd's figure from the timed step's event, never from its arrange's late event", async () => {
  const ctx = await setupTest();

  const feed = buildStubEventFeed();

  const arranged = buildMockImp({
    name: 'bench-0ddba11c0001-1-0',
    resources: { wakeCount: 1 },
    sleptAt: new Date('2026-10-01T10:00:00Z'),
  });

  const woken: Imp = {
    ...arranged,
    resources: { awakeMs: 0, wakeCount: 2 },
    sleptAt: new Date('2026-10-01T10:00:05Z'),
  };

  const scenario: BenchScenario = {
    name: 'wake',
    description: 'wake an imp that went to sleep after it woke',
    reason: 'woke',
    arrange: () =>
      Promise.resolve(async () => {
        await feed.send({
          // oxlint-disable-next-line id-length -- `v` is the event format's version field
          v: EVENT_VERSION,
          at: new Date('2026-10-01T10:00:06Z'),
          ev: 'ImpChanged',
          reason: 'woke',
          imp: woken,
          detail: { durationMs: 42 },
        });

        await feed.send({
          // oxlint-disable-next-line id-length -- `v` is the event format's version field
          v: EVENT_VERSION,
          at: new Date('2026-10-01T10:00:01Z'),
          ev: 'ImpChanged',
          reason: 'woke',
          imp: arranged,
          detail: { durationMs: 900 },
        });

        return woken;
      }),
  };

  const results = await runBench(
    {
      client: ctx.box.client,
      watchEvents: feed.watchEvents,
      now: () => performance.now(),
      wait: () => setImmediatePromise(),
      onProgress: () => {},
    },
    {
      runID: '0ddba11c0001',
      scenarios: [scenario],
      levels: [1],
      samples: 1,
      settings: { memoryMib: null, image: null, awakeMs: 0 },
    },
  );

  expect(results.map((result) => result.impdMs)).toStrictEqual([
    { p50: 42, p95: 42, p99: 42, max: 42 },
  ]);
});
