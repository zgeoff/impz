import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_VERSION, createImpClient } from '@impz/client';
import { makeStubImpdWithNewReason } from '@impz/client/test-utils/make-stub-impd-with-new-reason';
import {
  buildStubImageBuilder,
  claimFreePorts,
  createFilesTar,
  startBuilderImpd,
  startTestImpd,
} from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { ORPCError } from '@orpc/client';
import { HttpResponse, http } from 'msw';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = 'root-token';

  const workDir = await mkdtemp(join(tmpdir(), 'imp-client-engine-'));

  stack.defer(() => rm(workDir, { recursive: true, force: true }));

  const client = createImpClient({ url: 'http://impd.test/', token: rootToken });

  const startImpd = async (env: Readonly<Record<string, string>> = {}) => {
    const harness = await startTestImpd(stack, { rootToken, env });

    server.use(http.all('http://impd.test/*', (info) => harness.impd.api.app.handle(info.request)));

    return harness;
  };

  const startBuildImpd = async (builder: Parameters<typeof startBuilderImpd>[1]) => {
    const harness = await startBuilderImpd(stack, builder, { rootToken });

    server.use(http.all('http://impd.test/*', (info) => harness.impd.api.app.handle(info.request)));

    return harness;
  };

  return { client, startImpd, startBuildImpd, workDir, rootToken };
}

test('#createImpClient calls the contract under the base url with the bearer token', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');

  const paths = mock<(path: string) => void>();

  server.use(
    http.all('http://impd.test/*', (info) => {
      paths(new URL(info.request.url).pathname);

      return harness.impd.api.app.handle(info.request);
    }),
  );

  await ctx.client.imps.create({ name: 'dev' });

  const listed = await ctx.client.imps.list();

  expect(listed).toMatchObject([{ name: 'dev', state: 'running' }]);
  expect(paths.mock.calls).toStrictEqual([['/rpc/imps/create'], ['/rpc/imps/list']]);
});

test('#createImpClient rejects a call with a wrong token as UNAUTHORIZED', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  const client = createImpClient({ url: 'http://impd.test/', token: 'wrong' });

  expect(client.system.info()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('#createImpClient rejects a procedure impd does not have as an unknown procedure', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  server.use(
    http.all('http://impd.test/*', (info) =>
      harness.impd.api.app.handle(
        new Request(
          info.request.url.replace('/rpc/events/stream', '/rpc/events/retired'),
          info.request,
        ),
      ),
    ),
  );

  expect(ctx.client.events.stream()).rejects.toMatchObject({
    name: 'UnknownProcedureError',
    procedure: 'events.stream',
    message: 'impd has no procedure events.stream',
  });
});

test('#createImpClient keeps impd’s NOT_FOUND for an imp it does not have', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  expect(ctx.client.imps.get({ name: 'ghost' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    status: 404,
  });
});

test('#requireAwake wakes a sleeping imp', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'asleep' });
  await ctx.client.imps.sleep({ name: 'asleep' });

  const woken = await ctx.client.requireAwake('asleep');

  expect(woken.state).toBe('running');
});

test('#requireAwake boots a stopped imp', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'off' });
  await ctx.client.imps.stop({ name: 'off' });

  const booted = await ctx.client.requireAwake('off');

  expect(booted.state).toBe('running');
});

test('#requireAwake answers a running imp as it is', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const awake = await ctx.client.requireAwake('dev');

  expect(awake.state).toBe('running');
});

test('#requireAwake refuses an imp in error with INVALID_STATE', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');

  harness.fake.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => null);

  expect(ctx.client.requireAwake('dev')).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'error' },
  });
});

test('#requireAwake restarts an imp in error when told to', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');

  harness.fake.queue('boot', 'fail');

  await ctx.client.imps.create({ name: 'dev' }).catch(() => null);

  const restarted = await ctx.client.requireAwake('dev', { restartError: true });

  expect(restarted.state).toBe('running');
});

test('#requireAwake passes RAM_BUDGET_EXCEEDED on after one wake', async () => {
  const ctx = await setupTest();

  const harness = await ctx.startImpd({
    IMP_RAM_BUDGET_MIB: '600',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '100',
  });

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'a' });
  await ctx.client.imps.stop({ name: 'a' });
  await ctx.client.imps.create({ name: 'b' });
  await ctx.client.imps.hold({ name: 'b', seconds: 600 });

  const paths = mock<(path: string) => void>();

  server.use(
    http.all('http://impd.test/*', (info) => {
      paths(new URL(info.request.url).pathname);

      return harness.impd.api.app.handle(info.request);
    }),
  );

  const waking = ctx.client.requireAwake('a', { retryUnavailable: { attempts: 3, delayMs: 1 } });

  expect(waking).rejects.toMatchObject({
    code: 'RAM_BUDGET_EXCEEDED',
    data: { budgetMib: 600, requestedMib: 512 },
  });

  expect(paths).toHaveBeenCalledExactlyOnceWith('/rpc/imps/wake');
});

test('#requireAwake rejects with SERVICE_UNAVAILABLE while impd stops', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await harness.imps.sleepAllImps();

  expect(ctx.client.requireAwake('dev')).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
});

test('#requireAwake waits out a stopping impd for the one that replaces it when asked to', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');

  const stopping = harness.impd;

  await ctx.client.imps.create({ name: 'dev' });
  await stopping.imps.sleepAllImps();

  const replacement = await harness.restartImpd();

  const wakes = mock<(impd: string, status: number) => void>();

  server.use(
    http.post(
      'http://impd.test/rpc/imps/wake',
      async (info) => {
        const answer = await stopping.api.app.handle(info.request);

        wakes('stopping', answer.status);

        return answer;
      },
      { once: true },
    ),
    http.post('http://impd.test/rpc/imps/wake', async (info) => {
      const answer = await replacement.api.app.handle(info.request);

      wakes('replacement', answer.status);

      return answer;
    }),
  );

  const imp = await ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 2, delayMs: 1 },
  });

  expect(imp.state).toBe('running');

  expect(wakes.mock.calls).toStrictEqual([
    ['stopping', 503],
    ['replacement', 200],
  ]);
});

test('#requireAwake rejects with the TypeError of an impd it cannot reach', () => {
  const client = createImpClient({
    url: `http://127.0.0.1:${String(claimFreePorts(1).take())}/`,
    token: 'root-token',
  });

  expect(client.requireAwake('dev')).rejects.toBeInstanceOf(TypeError);
});

test('#requireAwake retries an impd it cannot reach when asked to', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  server.use(
    http.post('http://impd.test/rpc/imps/wake', () => HttpResponse.error(), { once: true }),
    http.post('http://impd.test/rpc/imps/wake', () => HttpResponse.error(), { once: true }),
  );

  const imp = await ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 2, delayMs: 1 },
  });

  expect(imp.state).toBe('running');
});

test('#requireAwake rejects with the abort reason when aborted while it waits to retry', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.sleep({ name: 'dev' });

  const wakes = mock<() => void>();

  const abort = new AbortController();
  const reason = new Error('gave up');

  server.use(
    http.post('http://impd.test/rpc/imps/wake', () => {
      wakes();

      return HttpResponse.error();
    }),
  );

  const waking = ctx.client.requireAwake('dev', {
    retryUnavailable: { attempts: 3, delayMs: 60_000 },
    signal: abort.signal,
  });

  await waitFor(() => {
    expect(wakes).toHaveBeenCalledOnce();
  });

  abort.abort(reason);

  expect(waking).rejects.toBe(reason);
  expect(wakes).toHaveBeenCalledOnce();
});

test('#requireAwake rejects with the reason of a signal that already aborted', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const reason = new Error('gave up');

  expect(ctx.client.requireAwake('dev', { signal: AbortSignal.abort(reason) })).rejects.toBe(
    reason,
  );
});

test('#checkServer reports both versions, that they are compatible, and the info it read', async () => {
  const ctx = await setupTest();

  await ctx.startImpd();

  const check = await ctx.client.checkServer();

  expect(check).toMatchObject({
    clientVersion: CLIENT_VERSION,
    serverVersion: CLIENT_VERSION,
    compatible: true,
    info: { version: CLIENT_VERSION, features: { leases: true } },
  });
});

test('#checkServer rejects at the abort of its signal when impd never answers', async () => {
  const ctx = await setupTest();

  const answer = mock(() => Promise.withResolvers<Response>().promise);

  server.use(http.post('http://impd.test/rpc/system/info', answer));

  const stopped = new AbortController();
  const reason = new Error('gave up');

  const check = ctx.client.checkServer({ signal: stopped.signal });

  await waitFor(() => {
    expect(answer).toHaveBeenCalledOnce();
  });

  stopped.abort(reason);

  expect(check).rejects.toBe(reason);
});

test('#images.addStream hands on each progress event, then the image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'from busybox\n' })],
    repoDigest: `sha256:${'d'.repeat(64)}`,
  });

  await ctx.startBuildImpd(builder);

  const events = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'box' });
  const received = await Array.fromAsync(events);

  expect(received).toStrictEqual([
    { type: 'progress', phase: 'pull', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'unpack', elapsedMs: expect.toBeNumber() },
    {
      type: 'image',
      image: {
        id: expect.toBeString(),
        name: 'box',
        ref: 'busybox:1.37',
        digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
        source: 'oci',
        createdAt: expect.toBeDate(),
        sizeBytes: expect.toBeNumber(),
        pinned: false,
      },
    },
  ]);
});

test('#images.addStream throws the ORPCError of an add that impd refuses', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'d'.repeat(64)}`,
  });

  await ctx.startBuildImpd(builder);

  const events = await ctx.client.images.addStream({ ref: 'busybox:1.37', name: 'imp-builder' });

  const reading = Array.fromAsync(events);

  expect(reading).rejects.toBeInstanceOf(ORPCError);

  expect(reading).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.toInclude("the image name imp-builder is impd's"),
  });
});

test('#images.buildStream hands on each progress event as it comes, then the image', async () => {
  const ctx = await setupTest();

  const release = Promise.withResolvers<void>();

  onTestFinished(() => {
    release.resolve();
  });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.workDir, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await release.promise;

      return {};
    },
  });

  await ctx.startBuildImpd(builder);

  await mkdir(join(ctx.workDir, 'context'));
  await writeFile(join(ctx.workDir, 'context', 'Dockerfile'), 'FROM scratch\n');

  const events = await ctx.client.images.buildStream({
    contextDir: join(ctx.workDir, 'context'),
    name: 'web',
  });

  const received: unknown[] = [];

  const reading = (async () => {
    for await (const event of events) {
      received.push(event);
    }
  })();

  await waitFor(() => {
    expect(received).toPartiallyContain({ type: 'progress', phase: 'build' });
  });

  const statusWhileBuilding = Bun.peek.status(reading);

  release.resolve();

  await reading;

  expect(statusWhileBuilding).toBe('pending');

  expect(received).toStrictEqual([
    { type: 'progress', phase: 'pack', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'build', elapsedMs: expect.toBeNumber() },
    { type: 'progress', phase: 'unpack', elapsedMs: expect.toBeNumber() },
    {
      type: 'image',
      image: {
        id: expect.toBeString(),
        name: 'web',
        ref: 'imp/web:latest',
        digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u),
        source: 'oci',
        createdAt: expect.toBeDate(),
        sizeBytes: expect.toBeNumber(),
        pinned: false,
      },
    },
  ]);
});

// oRPC checks outputs on the server, not in the client, so a reason this
// client does not know passes through.
test('#events.stream passes on an event whose reason this client does not know', async () => {
  const ctx = await setupTest();
  const harness = await ctx.startImpd();

  await harness.createTestImage('ubuntu');

  const newer = makeStubImpdWithNewReason(
    (request) => harness.impd.api.app.handle(request),
    'from-the-future',
  );

  server.use(http.all('http://impd.test/*', (info) => newer(info.request)));

  await ctx.client.imps.create({ name: 'dev' });

  const events = await ctx.client.events.stream();

  const reading = events[Symbol.asyncIterator]();

  onTestFinished(() => reading.return?.());

  await reading.next();
  await ctx.client.imps.sleep({ name: 'dev' });

  const changed = await reading.next();

  expect(changed.value).toMatchObject({
    ev: 'ImpChanged',
    reason: 'from-the-future',
    imp: { name: 'dev' },
  });
});
