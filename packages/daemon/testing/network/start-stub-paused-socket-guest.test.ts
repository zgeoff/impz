import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import { startStubBrokerSocketUpstream } from './start-stub-broker-socket-upstream';
import { startStubConnectProxy } from './start-stub-connect-proxy';
import { startStubPausedSocketGuest } from './start-stub-paused-socket-guest';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'stub-paused-guest-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const plain = await startStubBrokerSocketUpstream(stack, {
    directory: join(directory, 'plain'),
    isPlain: true,
  });

  return { stack, directoryPath: directory, plainPort: plain.port, sockets: plain.sockets };
}

test('it upgrades and hands back the 101 head', async () => {
  const ctx = await setupTest();

  const guest = await startStubPausedSocketGuest(ctx.stack, {
    port: ctx.plainPort,
    host: 'localhost',
    path: '/x',
  });

  expect(guest.head).toStartWith('HTTP/1.1 101 ');
});

test('it stops reading, so what the server sends piles up in the server', async () => {
  const ctx = await setupTest();

  await startStubPausedSocketGuest(ctx.stack, {
    port: ctx.plainPort,
    host: 'localhost',
    path: '/',
  });

  await waitFor(() => {
    expect(ctx.sockets).toHaveLength(1);
  });

  const chunk = Buffer.alloc(1024 * 1024, 7);

  await waitFor(() => {
    ctx.sockets[0]?.send(chunk);
    expect(ctx.sockets[0]?.getBufferedAmount()).toBeGreaterThan(4 * 1024 * 1024);
  });
});

test('it sees the server’s close once it reads again', async () => {
  const ctx = await setupTest();

  const guest = await startStubPausedSocketGuest(ctx.stack, {
    port: ctx.plainPort,
    host: 'localhost',
    path: '/',
  });

  await waitFor(() => {
    expect(ctx.sockets).toHaveLength(1);
  });

  ctx.sockets[0]?.terminate();
  guest.resume();

  await guest.closed;
});

test('it reaches the host through a CONNECT and TLS when it is given a tunnel', async () => {
  const ctx = await setupTest();

  const upstream = await startStubBrokerSocketUpstream(ctx.stack, {
    directory: ctx.directoryPath,
  });

  const proxy = await startStubConnectProxy(ctx.stack, { targetPort: upstream.port });

  const guest = await startStubPausedSocketGuest(ctx.stack, {
    port: proxy.port,
    host: 'localhost',
    path: '/v1/stream',
    tunnel: { ca: upstream.caPem },
  });

  expect(proxy.connects).toStrictEqual(['CONNECT localhost:443 HTTP/1.1']);
  expect(guest.head).toStartWith('HTTP/1.1 101 ');
  expect(upstream.upgrades).toPartiallyContain({ path: '/v1/stream' });
});
