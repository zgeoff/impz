import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Image } from '@impz/api';
import { buildMockImage } from '@impz/api/test-utils/build-mock-image';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../../testing/imps/build-mock-new-image';
import { buildStubImageBuilder } from '../../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../../testing/imps/create-files-tar';
import { startBuilderImpd } from '../../../../testing/imps/start-builder-impd';
import { buildStubRepeat } from '../../../../testing/platform/build-stub-repeat';
import { startTestImpd } from '../../../../testing/start-test-impd';
import { listApiCalls } from '../../../platform/db/api-audit';
import { createImage } from '../../../platform/db/images';
import { runChecked } from '../../../platform/process/run-command';
import { buildImagePaths } from '../../../vm/storage/data-layout';
import { runImageOp } from './image-op-stream';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'image-op-stream-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return {
    stack,
    directoryPath: directory,
    dataDir: join(directory, 'data'),

    cloneDisk: async (source: string, target: string) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
  };
}

test('it sends progress at once and at each phase, then the image', async () => {
  const clock = { now: 0 };
  const phaseReached = Promise.withResolvers<void>();
  const done = Promise.withResolvers<Image>();
  const image = buildMockImage();

  const events = runImageOp(
    async (_signal, report) => {
      await phaseReached.promise;

      clock.now = 4000;

      report.setPhase('unpack');

      return done.promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => clock.now,
      record: () => {},
    },
  );

  const first = await events.next();

  phaseReached.resolve();

  const second = await events.next();

  done.resolve(image);

  const third = await events.next();

  expect([first.value, second.value, third.value]).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: 0 },
    { type: 'progress', phase: 'unpack', elapsedMs: 4000 },
    { type: 'image', image },
  ]);
});

test('it records a null failure for work that ends with its image', async () => {
  const records: unknown[] = [];

  await Array.fromAsync(
    runImageOp(() => Promise.resolve(buildMockImage()), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (failure) => {
        records.push(failure);
      },
    }),
  );

  expect(records).toStrictEqual([null]);
});

test('it repeats the progress at each keepalive while the work is silent', async () => {
  const clock = { now: 0 };
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 15_000,
    now: () => clock.now,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const second = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(15_000)).toBe(1);
  });

  clock.now = 15_000;

  keepalive.tick(15_000);

  const progress = await second;

  expect(progress.value).toStrictEqual({ type: 'progress', phase: 'pull', elapsedMs: 15_000 });
});

test('it sends progress every 15 s through work silent for 400 s', async () => {
  const clock = { now: 0 };
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 15_000,
    now: () => clock.now,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const progress: unknown[] = [];

  for (const tick of Array.from({ length: 27 }, (_, index) => index + 1)) {
    const next = events.next();

    await waitFor(() => {
      expect(keepalive.countRunning(15_000)).toBe(1);
    });

    clock.now = tick * 15_000;

    keepalive.tick(15_000);

    const event = await next;

    progress.push(event.value);
  }

  expect(progress).toStrictEqual(
    Array.from({ length: 27 }, (_, index) => ({
      type: 'progress',
      phase: 'pull',
      elapsedMs: (index + 1) * 15_000,
    })),
  );
});

test('it throws the failure through the stream and records what was thrown', () => {
  const records: unknown[] = [];

  const failure = new Error('pull denied');

  const collected = Array.fromAsync(
    runImageOp(() => Promise.reject(failure), {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: (recorded) => {
        records.push(recorded);
      },
    }),
  );

  expect(collected).rejects.toBe(failure);
  expect(records).toStrictEqual([failure]);
});

test('it writes no audit row when the client leaves before the work ends', async () => {
  const records: unknown[] = [];

  const events = runImageOp(() => Promise.withResolvers<Image>().promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      records.push(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  expect(records).toStrictEqual([]);
});

test('it writes the audit row of work the client left once the work ends', async () => {
  const recorded = Promise.withResolvers<unknown>();
  const done = Promise.withResolvers<Image>();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: (failure) => {
      recorded.resolve(failure);
    },
  });

  await events.next();
  await events.return(undefined);

  done.resolve(buildMockImage());

  expect(recorded.promise).resolves.toBeNull();
});

test('it stops the keepalive timer once the work ends', async () => {
  const done = Promise.withResolvers<Image>();
  const keepalive = buildStubRepeat();

  const events = runImageOp(() => done.promise, {
    firstPhase: 'pull',
    signal: new AbortController().signal,
    keepaliveMs: 10_000,
    now: () => 0,
    record: () => {},
    repeat: keepalive.repeat,
  });

  await events.next();

  const imageEvent = events.next();

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  done.resolve(buildMockImage());

  await imageEvent;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it stops the keepalive timer of a wait the next phase ends', async () => {
  const phases: ((phase: 'unpack') => void)[] = [];
  const keepalive = buildStubRepeat();

  const events = runImageOp(
    (_signal, report) => {
      phases.push(report.setPhase);

      return Promise.withResolvers<Image>().promise;
    },
    {
      firstPhase: 'pull',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
      repeat: keepalive.repeat,
    },
  );

  await events.next();

  const next = events.next();

  const setPhase = await waitFor(() => {
    invariant(phases[0]);

    return phases[0];
  });

  await waitFor(() => {
    expect(keepalive.countRunning(10_000)).toBe(1);
  });

  setPhase('unpack');

  await next;

  expect(keepalive.countRunning(10_000)).toBe(0);
});

test('it sends the build output as log events in order, before the image', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 [2/3] RUN make all');
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
        logs: true,
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'log', text: '#4 [2/3] RUN make all' },
    { type: 'log', text: '#4 cc -o widget main.c' },
    { type: 'image', image },
  ]);
});

test('it sends progress with the step the build reached while it runs', async () => {
  const done = Promise.withResolvers<Image>();
  const reports: ((step: string) => void)[] = [];

  const events = runImageOp(
    (_signal, report) => {
      reports.push(report.output.setStep);

      return done.promise;
    },
    {
      firstPhase: 'build',
      signal: new AbortController().signal,
      keepaliveMs: 10_000,
      now: () => 0,
      record: () => {},
    },
  );

  await events.next();

  const next = events.next();

  const setStep = await waitFor(() => {
    invariant(reports[0]);

    return reports[0];
  });

  setStep('[3/3] RUN make install');

  const second = await next;

  done.resolve(buildMockImage());

  expect(second.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: 0,
    step: '[3/3] RUN make install',
  });
});

test('it holds at most 1 MiB of build output for a client that has not read, and counts what it dropped', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        for (let line = 0; line < 4096; line += 1) {
          report.output.emitLog('x'.repeat(8000));
        }

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
        logs: true,
      },
    ),
  );

  const kept = events.filter((event) => event.type === 'log' && event.text.startsWith('x'));

  expect(kept).toHaveLength(Math.floor(1024 ** 2 / 8000));

  expect(events.at(-2)).toStrictEqual({
    type: 'log',
    text: `imp: ${String(4096 - kept.length)} lines of build output dropped: the client read them more slowly than the build wrote them`,
  });

  expect(events.at(-1)).toStrictEqual({ type: 'image', image });
});

test('it sends no log events to a client that did not ask for them', async () => {
  const image = buildMockImage();

  const events = await Array.fromAsync(
    runImageOp(
      (_signal, report) => {
        report.output.emitLog('#4 cc -o widget main.c');

        return Promise.resolve(image);
      },
      {
        firstPhase: 'build',
        signal: new AbortController().signal,
        keepaliveMs: 10_000,
        now: () => 0,
        record: () => {},
      },
    ),
  );

  expect(events).toStrictEqual([
    { type: 'progress', phase: 'build', elapsedMs: 0 },
    { type: 'image', image },
  ]);
});

test('it streams the phases of an add, then the image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const stream = await harness.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });
  const events = await Array.fromAsync(stream);

  const phases = events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []));

  expect(phases.filter((phase, index) => phases[index - 1] !== phase)).toStrictEqual([
    'pull',
    'unpack',
  ]);

  expect(events.at(-1)).toMatchObject({
    type: 'image',
    image: { name: 'box', createdAt: expect.any(Date) as unknown },
  });
});

test('it audits a streamed add as ok once it ends', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const stream = await harness.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });

  await Array.fromAsync(stream);

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([['ok', null]]);
});

test("it keeps the reference a streamed add's pull resolved in its audit row", async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'d'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const stream = await harness.client.images.addStream({ ref: 'busybox', name: 'box' });

  await Array.fromAsync(stream);

  const details = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds.map((row) => row.detail);
  });

  expect(details).toStrictEqual([`busybox@sha256:${'d'.repeat(64)}`]);
});

test('it streams the copy of a template and audits it with its imp', async () => {
  const ctx = await setupTest();

  const harness = await startTestImpd(ctx.stack, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  await harness.client.imps.create({ name: 'source', image: 'base' });

  const stream = await harness.client.images.addStream({ imp: 'source', name: 'tpl' });
  const events = await Array.fromAsync(stream);

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect([
    ...new Set(events.flatMap((event) => (event.type === 'progress' ? [event.phase] : []))),
  ]).toStrictEqual(['copy']);

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'tpl', source: 'imp' } });
  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([['ok', 'source']]);
});

test('it throws a failed add through the stream with a code that keeps its message out', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { tag: 'no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const stream = await harness.client.images.addStream({ ref: 'busybox:1.37' });

  const adding = Array.fromAsync(stream);

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  expect(adding).rejects.not.toThrow('no space left on device');
});

test('it audits a failed streamed add with its code', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { tag: 'no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const stream = await harness.client.images.addStream({ ref: 'busybox:1.37' });

  expect(Array.fromAsync(stream)).rejects.toThrow();

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => [row.outcome, row.imp ?? null])).toStrictEqual([
    ['INTERNAL_SERVER_ERROR', null],
  ]);
});

test('it refuses a streamed add to a read token and audits the refusal', async () => {
  const ctx = await setupTest();
  const harness = await startTestImpd(ctx.stack, { dataDir: ctx.dataDir });
  const made = await harness.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader = harness.buildClient(made.secret);
  const adding = reader.images.addStream({ ref: 'busybox:1.37' });

  expect(adding).rejects.toMatchObject({ code: 'FORBIDDEN' });

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();

    return adds;
  });

  expect(calls.map((row) => row.outcome)).toStrictEqual(['FORBIDDEN']);
});

test('it refuses a streamed build to a read token and audits the refusal', async () => {
  const ctx = await setupTest();
  const harness = await startTestImpd(ctx.stack, { dataDir: ctx.dataDir });
  const made = await harness.client.tokens.create({ name: 'reader', scope: 'read' });

  const reader = harness.buildClient(made.secret);
  const building = reader.images.buildStream({ contextDir: '/srv/ctx', name: 'web' });

  expect(building).rejects.toMatchObject({ code: 'FORBIDDEN' });

  const calls = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();

    return builds;
  });

  expect(calls.map((row) => row.outcome)).toStrictEqual(['FORBIDDEN']);
});

test('it streams the pack, then the build, of a build from a directory', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.directoryPath, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => Promise.withResolvers<never>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const client = new AbortController();

  const events = await harness.client.images.buildStream(
    { contextDir, name: 'web' },
    { signal: client.signal },
  );

  const first = await events.next();
  const second = await events.next();

  client.abort();

  expect(first.value).toStrictEqual({
    type: 'progress',
    phase: 'pack',
    elapsedMs: expect.any(Number) as unknown,
  });

  expect(second.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: expect.any(Number) as unknown,
  });
});

test('it stops the builder build of a streamed build whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.directoryPath, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => Promise.withResolvers<never>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const client = new AbortController();

  const events = await harness.client.images.buildStream(
    { contextDir, name: 'web' },
    { signal: client.signal },
  );

  await events.next();

  const build = await waitFor(() => {
    const run = builder.guest.runs.find((candidate) => candidate.argv[1] === 'build');

    invariant(run);

    return run;
  });

  client.abort();

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();
    expect(build.closed).toBeTrue();

    return builds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
});

test('it stops the builder pull of a streamed add whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => Promise.withResolvers<never>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const client = new AbortController();

  const events = await harness.client.images.addStream(
    { ref: 'registry.test/big:1' },
    { signal: client.signal },
  );

  await events.next();

  const pull = await waitFor(() => {
    const run = builder.guest.runs.find((candidate) => candidate.argv[1] === 'pull');

    invariant(run);

    return run;
  });

  client.abort();

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.addStream');

    expect(adds).not.toBeEmpty();
    expect(pull.closed).toBeTrue();

    return adds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
});

test('it stops the builder build of a plain build whose client goes', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.directoryPath, 'context');

  await mkdir(contextDir);
  await writeFile(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => Promise.withResolvers<never>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const client = new AbortController();

  const building = harness.client.images.build(
    { contextDir, name: 'web' },
    { signal: client.signal },
  );

  const build = await waitFor(() => {
    const run = builder.guest.runs.find((candidate) => candidate.argv[1] === 'build');

    invariant(run);

    return run;
  });

  client.abort();

  expect(building).rejects.toThrow();

  const closed = await waitFor(() => {
    expect(build.closed).toBeTrue();

    return build.closed;
  });

  expect(closed).toBeTrue();
});

test('it stops the builder pull of a plain add whose client goes, and audits it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => Promise.withResolvers<never>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    cloneDisk: ctx.cloneDisk,
  });

  const client = new AbortController();

  const adding = harness.client.images.add(
    { ref: 'busybox:1.37', name: 'box' },
    { signal: client.signal },
  );

  const pull = await waitFor(() => {
    const run = builder.guest.runs.find((candidate) => candidate.argv[1] === 'pull');

    invariant(run);

    return run;
  });

  client.abort();

  expect(adding).rejects.toThrow();

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const adds = rows.filter((row) => row.procedure === 'images.add');

    expect(adds).not.toBeEmpty();
    expect(pull.closed).toBeTrue();

    return adds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
});
