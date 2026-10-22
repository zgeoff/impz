import { expect, mock, onTestFinished, test } from 'bun:test';
import { faker } from '@faker-js/faker';
import {
  ErrorResponseSchema,
  FRAME_TYPES,
  OKSchema,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import { TUNNEL_MAX_FRAME_BYTES, TUNNEL_WINDOW_BYTES } from '@impz/api';
import { createImpClient, openForwardTunnel } from '@impz/client';
import type { ForwardTunnelEnd } from '@impz/client';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  claimFreePorts,
  createImage,
  readVmIdentity,
  startStubAgent,
  startStubDialAgent,
  startTestImpd,
  writeVmIdentity,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const url = harness.url;
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  return {
    dataDir: harness.dataDir,
    client: createImpClient({ url, token: rootToken }),
    baseUrl: url,
    token: rootToken,
  };
}

test('it relays bytes and the eof both ways to the port in the imp', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  const agent = await startStubDialAgent(paths.vsockSocket, (asked) => `got ${asked}`);

  onTestFinished(() => {
    agent.close();
  });

  const replies: string[] = [];
  const ended = Promise.withResolvers<ForwardTunnelEnd>();
  const onEof = mock<() => void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 5432,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {
      tunnel.send(new TextEncoder().encode('hello'));
      tunnel.sendEof();
    },
    onData: (data) => {
      replies.push(new TextDecoder().decode(data));
    },
    onEof,
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({ kind: 'done' });
  expect(replies.join('')).toBe('got hello');
  expect(onEof).toHaveBeenCalledOnce();
});

test('it holds bytes past the window until impd acks them', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  const agent = await startStubAgent(paths.vsockSocket, (socket) => {
    socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    socket.pause();
  });

  onTestFinished(() => {
    agent.close();
  });

  const accepted = Promise.withResolvers<boolean>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 80,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {
      accepted.resolve(tunnel.send(new Uint8Array(4 * TUNNEL_WINDOW_BYTES)));
    },
    onData: () => {},
    onEof: () => {},
    onEnd: () => {},
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const isAccepted = await accepted.promise;

  expect(isAccepted).toBeFalse();

  await waitFor(() => {
    expect(tunnel.countUnackedBytes()).toBeGreaterThan(TUNNEL_WINDOW_BYTES);
  });

  expect(tunnel.countUnackedBytes()).toBeLessThanOrEqual(
    TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES,
  );
});

test('it ends as failed with impd’s code when the dial in the imp fails', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  const agent = await startStubAgent(paths.vsockSocket, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:9: connection refused' },
      }),
    );
  });

  onTestFinished(() => {
    agent.close();
  });

  const ended = Promise.withResolvers<ForwardTunnelEnd>();
  const onOpened = mock<() => void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 9,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened,
    onData: () => {},
    onEof: () => {},
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({
    kind: 'failed',
    code: 'DIAL_FAILED',
    message: 'dial tcp 127.0.0.1:9: connection refused',
  });

  expect(onOpened).not.toHaveBeenCalled();
});

test('it ends as unreachable when nothing answers at impd’s address', async () => {
  const ended = Promise.withResolvers<ForwardTunnelEnd>();

  const tunnel = openForwardTunnel({
    baseUrl: `http://127.0.0.1:${String(claimFreePorts(1).take())}`,
    token: 'root-token',
    name: 'box',
    port: 80,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    onOpened: () => {},
    onData: () => {},
    onEof: () => {},
    onEnd: ended.resolve,
  });

  onTestFinished(() => {
    tunnel.close();
  });

  const end = await ended.promise;

  expect(end).toStrictEqual({ kind: 'unreachable' });
});

test('it calls nothing back once the caller closed it', async () => {
  const ctx = await setupTest();

  const onEnd = mock<(end: ForwardTunnelEnd) => void>();
  const closed = Promise.withResolvers<void>();

  const tunnel = openForwardTunnel({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    name: 'box',
    port: 80,
    connect: (url, headers) => {
      const ws = new WebSocket(url, { headers: { ...headers } });

      ws.addEventListener('close', () => {
        closed.resolve();
      });

      return ws;
    },
    onOpened: () => {},
    onData: () => {},
    onEof: () => {},
    onEnd,
  });

  tunnel.close();

  await closed.promise;

  expect(onEnd).not.toHaveBeenCalled();
});
