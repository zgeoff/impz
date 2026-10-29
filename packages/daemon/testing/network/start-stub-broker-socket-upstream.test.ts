import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { waitFor } from '@impz/test-utils/wait-for';
import { startStubBrokerSocketUpstream } from './start-stub-broker-socket-upstream';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'stub-socket-upstream-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it echoes each message and records it', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
  });

  const socket = new WebSocket(`wss://localhost:${String(upstream.port)}/x`, {
    tls: { ca: [upstream.caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const echoed: unknown[] = [];

  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    echoed.push(event.data);
  });

  socket.addEventListener('open', () => {
    socket.send('ping');
  });

  await waitFor(() => {
    expect(echoed).toHaveLength(1);
  });

  expect(echoed).toStrictEqual(['ping']);
  expect(upstream.received).toStrictEqual(['ping']);
});

test('it records the path, the authorization and the offered subprotocols of each upgrade, and picks the first', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
  });

  const socket = new WebSocket(`wss://localhost:${String(upstream.port)}/v1/stream`, {
    tls: { ca: [upstream.caPem] },
    headers: { authorization: 'Bearer test-key' },
    protocols: ['realtime', 'chat.v2'],
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  await waitFor(() => {
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });

  expect(socket.protocol).toBe('realtime');

  expect(upstream.upgrades).toStrictEqual([
    { path: '/v1/stream', authorization: 'Bearer test-key', protocols: 'realtime, chat.v2' },
  ]);
});

test('it answers the upgrade with the headers it is given', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
    upgradeHeaders: { 'set-cookie': 'edge=abc' },
  });

  const head = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];

  const socket = connect(
    { host: '127.0.0.1', port: upstream.port, servername: 'localhost', ca: [upstream.caPem] },
    () => {
      socket.write(
        'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\n' +
          `Sec-WebSocket-Key: ${Buffer.from('imp-test-socket!').toString('base64')}\r\n\r\n`,
      );
    },
  );

  ctx.stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);

    const text = Buffer.concat(chunks).toString();

    if (text.includes('\r\n\r\n')) {
      head.resolve(text);
    }
  });

  const text = await head.promise;

  expect(text.toLowerCase()).toInclude('\r\nset-cookie: edge=abc\r\n');
});

test('it records the code and reason of each close', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
  });

  const socket = new WebSocket(`wss://localhost:${String(upstream.port)}/x`, {
    tls: { ca: [upstream.caPem] },
  });

  socket.addEventListener('open', () => {
    socket.close(4001, 'bye');
  });

  await waitFor(() => {
    expect(upstream.closes).toHaveLength(1);
  });

  expect(upstream.closes).toStrictEqual([{ code: 4001, reason: 'bye' }]);
});

test('it hands out each open socket', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
  });

  const socket = new WebSocket(`wss://localhost:${String(upstream.port)}/x`, {
    tls: { ca: [upstream.caPem] },
  });

  ctx.stack.defer(() => {
    socket.close();
  });

  const pushed: unknown[] = [];

  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    pushed.push(event.data);
  });

  await waitFor(() => {
    expect(upstream.sockets).toHaveLength(1);
  });

  upstream.sockets[0]?.send('from the service');

  await waitFor(() => {
    expect(pushed).toStrictEqual(['from the service']);
  });
});
