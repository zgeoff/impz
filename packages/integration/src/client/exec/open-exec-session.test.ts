import { expect, mock, onTestFinished, test } from 'bun:test';
import { createImpClient, openExecSession } from '@impz/client';
import type { ExecSession, ExecStarted } from '@impz/client';
import { createStubUndiciWebSocket } from '@impz/client/test-utils/create-stub-undici-web-socket';
import { makeStubImpdWithoutFeature } from '@impz/client/test-utils/make-stub-impd-without-feature';
import { startStubImpdSocket } from '@impz/client/test-utils/start-stub-impd-socket';
import {
  buildImpPaths,
  buildStubExecAgent,
  claimFreePorts,
  startStubAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { server } from '@impz/test-utils/mock-server';
import { http } from 'msw';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = 'root-token';

  const harness = await startTestImpd(stack, { rootToken });

  const impd = harness.impd;

  server.use(http.all('http://impd.test/*', (info) => impd.api.app.handle(info.request)));

  const url = harness.url;
  const client = createImpClient({ url, token: rootToken });
  const agent = buildStubExecAgent();

  return {
    stack,
    dataDir: harness.dataDir,
    createTestImage: harness.createTestImage,
    fake: harness.fake,
    impd,
    url,
    client,
    agent,
    rootToken,
  };
}

test('it reports a refused ticket with a good token as unauthorized, naming the ticket', async () => {
  const ctx = await setupTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    ticket: 'used.ticket',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized', ticketRefused: true });
});

test('it reports a refused upgrade that only an error event tells of as unauthorized', async () => {
  const ctx = await setupTest();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: 'not-the-token',
    start: { name: 'dev', argv: ['cat'], tty: false },
    onStarted: () => {},
    onOutput: () => {},

    connect: (url) => createStubUndiciWebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unauthorized' });
});

test('it reads a start that impd answers without output as continuity none', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await startStubAgent(buildImpPaths(ctx.dataDir, dev.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const started = mock<(info: ExecStarted) => void>();

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: started,
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(started).toHaveBeenCalledExactlyOnceWith({
    pid: 42,
    session: null,
    created: false,
    groupKill: false,
    output: { continuity: 'none' },
  });

  expect(outcome).toStrictEqual({ kind: 'exit', code: 3, signal: null });
});

test('it asks impd before it sends a start that requires anything', async () => {
  const ctx = await setupTest();

  const calls = mock<(path: string) => void>();

  const older = makeStubImpdWithoutFeature(
    (request) => ctx.impd.api.app.handle(request),
    'execRequire',
  );

  server.use(
    http.all('http://impd.test/*', (info) => {
      calls(new URL(info.request.url).pathname);

      return older(info.request);
    }),
  );

  const session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['tick'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({
    kind: 'failed',
    code: 'PRECONDITION_FAILED',
    message: expect.toInclude('older than 0.30.0'),
    data: { reason: 'impd_outdated', detail: expect.toBeString() },
  });

  expect(calls).toHaveBeenCalledExactlyOnceWith('/rpc/system/features');
  expect(ctx.agent.requests).toStrictEqual([]);
});

test('it sends a resize made while the start waits on impd after the start', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await startStubAgent(buildImpPaths(ctx.dataDir, dev.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const held: { session: ExecSession | null } = { session: null };

  server.use(
    http.post('http://impd.test/rpc/system/features', (info) => {
      const request = info.request;

      held.session?.resize(100, 40);

      return ctx.impd.api.app.handle(request);
    }),
  );

  held.session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['wait'], tty: false, require: ['broker'] },

    onStarted: () => {
      held.session?.sendSignal('SIGTERM');
    },
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await held.session.outcome;

  expect(outcome).toStrictEqual({ kind: 'exit', code: null, signal: 'SIGTERM' });
  expect(ctx.agent.input).toStrictEqual(['resize:100x40', 'signal:15']);
});

test('it counts stdin held while the start waits on impd toward backpressure', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await startStubAgent(buildImpPaths(ctx.dataDir, dev.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_SECRET' });
  await ctx.client.grants.add({ name: 'dev', secret: 'gh' });

  const held: { session: ExecSession | null } = { session: null };
  const seen = { accepted: true, drainedDuringCheck: true };

  server.use(
    http.post('http://impd.test/rpc/system/features', async (info) => {
      const request = info.request;
      const session = held.session;

      seen.accepted = session?.sendStdin(new Uint8Array(1_048_577)) ?? true;

      const draining = session?.waitForDrain() ?? Promise.resolve();

      const response = await ctx.impd.api.app.handle(request);

      seen.drainedDuringCheck = Bun.peek.status(draining) !== 'pending';

      return response;
    }),
  );

  held.session = openExecSession({
    baseUrl: 'http://impd.test',
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false, require: ['broker'] },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) =>
      new WebSocket(url.replace('ws://impd.test', ctx.url.replace('http', 'ws')), {
        headers: { ...headers },
      }),
  });

  const outcome = await held.session.outcome;

  expect(seen.accepted).toBeFalse();
  expect(seen.drainedDuringCheck).toBeFalse();
  expect(outcome).toStrictEqual({ kind: 'exit', code: 3, signal: null });
});

test('it reports an impd it cannot reach as unreachable', async () => {
  const baseUrl = `http://127.0.0.1:${String(claimFreePorts(1).take())}`;

  const session = openExecSession({
    baseUrl,
    token: 'root-token',
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'unreachable', detail: expect.toBeString() });
});

test('it reports an output handler that throws as a local error with what it threw', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const dev = await ctx.client.imps.create({ name: 'dev' });

  await startStubAgent(buildImpPaths(ctx.dataDir, dev.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const thrown = new Error('EPIPE');

  const session = openExecSession({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {
      throw thrown;
    },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'local_error', error: thrown });
});

test('it reports a message it does not know as a bad message', async () => {
  const impd = startStubImpdSocket(['{"type":"from-the-future"}']);

  const session = openExecSession({
    baseUrl: impd.url,
    token: null,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({
    kind: 'bad_message',
    detail: 'unknown message: {"type":"from-the-future"}',
  });
});

test('it reports a message that is not JSON as a bad message', async () => {
  const impd = startStubImpdSocket(['not json']);

  const session = openExecSession({
    baseUrl: impd.url,
    token: null,
    start: { name: 'dev', argv: ['fail'], tty: false },
    onStarted: () => {},
    onOutput: () => {},
    connect: (url) => new WebSocket(url),
  });

  const outcome = await session.outcome;

  expect(outcome).toStrictEqual({ kind: 'bad_message', detail: expect.toBeString() });
});
