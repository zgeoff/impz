import { expect, onTestFinished, test } from 'bun:test';
import { TUNNEL_CLOSE_RESTARTING } from '@impz/api';
import { createImpClient, openReverseForward } from '@impz/client';
import {
  buildImpPaths,
  buildStubForwardAgent,
  startStubAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';

// impd listens on a loopback port, as /tunnel needs a real socket.
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = 'root-token';

  const harness = await startTestImpd(stack, { rootToken });

  const impd = harness.impd;

  harness.fake.agent.version = '0.18.0';

  const url = harness.url;
  const client = createImpClient({ url, token: rootToken });
  const agent = buildStubForwardAgent();

  return {
    stack,
    dataDir: harness.dataDir,
    createTestImage: harness.createTestImage,
    impd,
    url,
    client,
    agent,
    rootToken,
  };
}

test('it listens where impd answers', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  const listening = await forward.listening;

  expect(listening).toStrictEqual({ path: '/tmp/app.sock', port: null });
});

test('it relays a client in the imp that it accepts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const replies: string[] = [];

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: (accept) => {
      const relay = accept({
        onData: (data) => {
          replies.push(new TextDecoder().decode(data));
        },
        onEof: () => {
          relay.sendEof();
        },
        onClose: () => {},
      });

      relay.send(new TextEncoder().encode('hello'));
    },
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.agent.connect(3);

  await waitFor(() => {
    expect(replies).toStrictEqual(['got hello']);
  });

  expect(ctx.agent.requests).toPartiallyContain({
    op: 'agent.accept',
    listener: 'fwd1',
    connection: 3,
  });
});

test('it ends as lost when its listener in the imp ends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.agent.endListeners();

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'lost' });
});

test('it ends as failed with the refusal of a listen impd refused', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  ctx.agent.refuseListens({ code: 'LISTEN_FAILED', message: 'address in use' });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'failed', code: 'LISTEN_FAILED', message: 'address in use' });
  expect(forward.listening).rejects.toThrowWithMessage(Error, 'address in use');
});

test('it ends as stopped on stop', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  await forward.listening;

  forward.stop();

  const end = await forward.ended;

  expect(end).toStrictEqual({ kind: 'stopped' });
});

test('it ends as closed with the code and reason of a tunnel impd closes as it restarts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const box = await ctx.client.imps.create({ name: 'box' });

  await startStubAgent(buildImpPaths(ctx.dataDir, box.id).vsockSocket, ctx.agent.readFrame, {
    stack: ctx.stack,
  });

  const forward = openReverseForward({
    baseUrl: ctx.url,
    token: ctx.rootToken,
    name: 'box',
    guest: { network: 'unix', path: '/tmp/app.sock' },
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onConnection: () => {},
  });

  onTestFinished(forward.stop);

  await forward.listening;

  ctx.impd.api.closeExecSessions();

  const end = await forward.ended;

  expect(end).toStrictEqual({
    kind: 'closed',
    code: TUNNEL_CLOSE_RESTARTING,
    reason: 'impd is restarting',
  });
});
