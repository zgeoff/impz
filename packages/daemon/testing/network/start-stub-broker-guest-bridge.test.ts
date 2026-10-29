import { expect, onTestFinished, test } from 'bun:test';
import { createConnection } from 'node:net';
import { waitFor } from '@impz/test-utils/wait-for';
import type { Socket } from 'bun';
import { startStubBrokerGuestBridge } from './start-stub-broker-guest-bridge';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const accepted: Socket[] = [];
  const received: string[] = [];

  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (socket) => {
        accepted.push(socket);
      },
      data: (socket, data) => {
        received.push(data.toString());
        socket.write(`echo ${data.toString()}`);
      },
    },
  });

  stack.defer(() => {
    server.stop(true);
  });

  return { stack, port: server.port, accepted, received };
}

test('it reaches the proxy port from the guest address it is given', async () => {
  const ctx = setupTest();

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.port,
    address: '127.0.0.2',
  });

  const client = createConnection({
    host: '127.0.0.1',
    port: Number(new URL(bridge.proxyURL).port),
  });

  ctx.stack.defer(() => {
    client.destroy();
  });

  await waitFor(() => {
    expect(ctx.accepted).toHaveLength(1);
  });

  expect(ctx.accepted[0]?.remoteAddress).toBe('127.0.0.2');
});

test('it passes bytes both ways', async () => {
  const ctx = setupTest();

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.port,
    address: '127.0.0.2',
  });

  const replies: string[] = [];

  const client = createConnection({
    host: '127.0.0.1',
    port: Number(new URL(bridge.proxyURL).port),
  });

  ctx.stack.defer(() => {
    client.destroy();
  });

  client.on('data', (chunk: Buffer) => {
    replies.push(chunk.toString());
  });

  client.write('hello');

  await waitFor(() => {
    expect(replies).toStrictEqual(['echo hello']);
  });

  expect(ctx.received).toStrictEqual(['hello']);
});

test('it lets Bun’s WebSocket use it as a proxy for a public host name', async () => {
  const ctx = setupTest();

  const bridge = await startStubBrokerGuestBridge(ctx.stack, {
    proxyPort: ctx.port,
    address: '127.0.0.2',
  });

  const socket = new WebSocket('wss://realtime.example.com/x', { proxy: bridge.proxyURL });

  ctx.stack.defer(() => {
    socket.close();
  });

  await waitFor(() => {
    expect(ctx.received).toStrictEqual([expect.toStartWith('CONNECT realtime.example.com:443 ')]);
  });
});
