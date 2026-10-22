import { expect, mock, onTestFinished, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { faker } from '@faker-js/faker';
import {
  ErrorResponseSchema,
  FRAME_TYPES,
  OKSchema,
  decodeJsonPayload,
  encodeFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_CLOSE_RESTARTING,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
} from '@impz/api';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  claimFreePorts,
  createImage,
  startStubAgent,
  startStubDialAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createImpClient } from '../config/create-imp-client';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { sendLocalRequest } from '../test-utils/send-local-request';
import { startStubTunnelFaultProxy } from '../test-utils/start-stub-tunnel-fault-proxy';
import { formatTunnelClose, startProxy } from './proxy-client';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const server = harness.impd.app.server;

  invariant(server);

  const url = harness.url;

  return {
    stack,
    rootToken,
    dataDir: harness.dataDir,
    db: harness.db,
    impd: harness.impd,
    fake: harness.fake,
    server,
    url,
    client: createImpClient({ url, token: rootToken }),
  };
}

test('#startProxy relays a half-closed request and its reply on both loopbacks', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  const agent = await startStubDialAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (asked) => `got ${asked}`,
    { stack: ctx.stack },
  );

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 5432 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const ipv4Reply = await sendLocalRequest('127.0.0.1', port, new TextEncoder().encode('hello'));
  const ipv6Reply = await sendLocalRequest('::1', port, new TextEncoder().encode('hi'));

  expect(ipv4Reply).toBe('got hello');
  expect(ipv6Reply).toBe('got hi');

  expect(
    agent.received
      .filter((frame) => frame.type === FRAME_TYPES.request)
      .map((frame) => decodeJsonPayload(frame)),
  ).toStrictEqual([
    { op: 'dial', network: 'tcp', address: '127.0.0.1:5432' },
    { op: 'dial', network: 'tcp', address: '127.0.0.1:5432' },
  ]);

  expect(writeNotice).not.toHaveBeenCalled();
});

test('#startProxy stops reading an upload at the window while the guest takes none of it', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  // the guest's server takes the dial, then reads nothing, so impd holds
  // its acks once the agent's socket is full
  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    socket.pause();
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const onWindowFull = mock<(unackedBytes: number) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice: () => {}, onWindowFull },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const upload = connect({ host: '127.0.0.1', port });

  ctx.stack.defer(() => {
    upload.destroy();
  });

  upload.on('error', () => {});
  upload.end(new Uint8Array(4 * TUNNEL_WINDOW_BYTES));

  await waitFor(() => {
    expect(onWindowFull).toHaveBeenCalled();
  });

  // past the window by one frame at most, as impd allows
  expect(onWindowFull.mock.calls).toSatisfyAll(
    ([unacked]: readonly [number]) =>
      unacked > TUNNEL_WINDOW_BYTES && unacked <= TUNNEL_WINDOW_BYTES + TUNNEL_MAX_FRAME_BYTES,
  );
});

test('#startProxy sends the rest of an upload once the guest takes it again', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  const size = 4 * TUNNEL_WINDOW_BYTES;
  const guest = Promise.withResolvers<Socket>();

  // the guest holds the dial unanswered and unread, so the whole upload
  // reaches the client before any ack can; once whole, it answers its size
  const agent = await startStubAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (socket, _request, frames) => {
      if (frames.length === 1) {
        socket.pause();
        guest.resolve(socket);
      } else if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        const bytes = frames
          .filter((frame) => frame.type === FRAME_TYPES.stdin)
          .reduce((total, frame) => total + frame.payload.byteLength, 0);

        const answer = new TextEncoder().encode(`got ${String(bytes)}`);

        socket.write(encodeFrame(FRAME_TYPES.stdout, answer));
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }
    },
  );

  ctx.stack.defer(() => {
    agent.close();
  });

  const onWindowFull = mock<(unackedBytes: number) => void>();
  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, onWindowFull },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(size));

  const dialed = await guest.promise;

  dialed.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));

  await waitFor(() => {
    expect(onWindowFull).toHaveBeenCalled();
  });

  dialed.resume();

  const replied = await reply;

  expect(replied).toBe(`got ${String(size)}`);
  expect(writeNotice).not.toHaveBeenCalled();
});

test('#startProxy fails at once naming a local port in use, before any call to impd', async () => {
  const port = claimFreePorts(1).take();
  const busy = createServer();

  onTestFinished(() => {
    busy.close();
  });

  const listening = Promise.withResolvers<void>();

  busy.listen(port, '127.0.0.1', listening.resolve);

  await listening.promise;

  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: port, remote: 5432 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    new RegExp(
      `^local port ${String(port)} is in use; map another one: impz proxy box \\d+:5432 \\(0:5432 takes any free port\\)$`,
      'u',
    ),
  );
});

test('#startProxy fails naming the local port when only its IPv6 loopback is in use', async () => {
  const port = claimFreePorts(1).take();
  const busy = createServer();

  onTestFinished(() => {
    busy.close();
  });

  const listening = Promise.withResolvers<void>();

  busy.listen(port, '::1', listening.resolve);

  await listening.promise;

  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: port, remote: 5432 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    new RegExp(`^local port ${String(port)} is in use; map another one: impz proxy box `, 'u'),
  );
});

test.skipIf(
  process.getuid?.() === 0 ||
    Number(readFileSync('/proc/sys/net/ipv4/ip_unprivileged_port_start', 'utf8')) <= 1,
)('#startProxy fails naming a privileged local port, with one above 1023 to map', () => {
  const started = startProxy(
    { url: 'http://127.0.0.1:1', token: 'root-token', host: null },
    'box',
    [{ local: 1, remote: 80 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toThrowWithMessage(
    Error,
    'local port 1 needs privileges; map a port above 1023: impz proxy box 8001:80',
  );
});

test('#startProxy rejects an imp that impd does not have, and frees its local port', async () => {
  const ctx = await setupTest();

  const port = claimFreePorts(1).take();

  const started = startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'nope',
    [{ local: port, remote: 80 }],
    { writeNotice: () => {} },
  );

  expect(started).rejects.toMatchObject({ code: 'NOT_FOUND' });

  const again = createServer();

  onTestFinished(() => {
    again.close();
  });

  const listening = new Promise<void>((resolve, reject) => {
    again.once('error', reject);
    again.listen(port, '127.0.0.1', resolve);
  });

  await expect(listening).toResolve();
});

test('#startProxy reports impd’s refusal of a dial and resets the local connection', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: { code: 'DIAL_FAILED', message: 'dial tcp 127.0.0.1:9: connection refused' },
      }),
    );
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 9 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(1));

  expect(reply).rejects.toMatchObject({ code: 'ECONNRESET' });

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledExactlyOnceWith(
      'box:9: DIAL_FAILED: dial tcp 127.0.0.1:9: connection refused',
    );
  });
});

test('#startProxy ends only the tunnel that gets a message that is not JSON, and closes its local connection', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  await startStubDialAgent(
    buildImpPaths(ctx.dataDir, imp.id).vsockSocket,
    (asked) => `got ${asked}`,
    { stack: ctx.stack },
  );

  // impd itself never sends text that is not JSON, so a proxy injects it
  const faulty = startStubTunnelFaultProxy(ctx.stack, ctx.url);
  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: faulty.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 5432 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const broken = connect({ host: '127.0.0.1', port });
  const brokenEnd = Promise.withResolvers<boolean>();

  broken.on('close', brokenEnd.resolve);

  ctx.stack.defer(() => {
    broken.destroy();
  });

  await waitFor(() => {
    expect(faulty.tunnels[0]?.toClient).toContain('{"type":"opened"}');
  });

  const sibling = connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  const siblingReply = Promise.withResolvers<string>();
  const siblingChunks: Buffer[] = [];

  sibling.on('data', (chunk: Buffer) => {
    siblingChunks.push(chunk);
  });

  sibling.on('error', siblingReply.reject);

  sibling.on('close', () => {
    siblingReply.resolve(Buffer.concat(siblingChunks).toString());
  });

  ctx.stack.defer(() => {
    sibling.destroy();
  });

  await waitFor(() => {
    expect(faulty.tunnels[1]?.toClient).toContain('{"type":"opened"}');
  });

  faulty.sendText(0, 'not json');

  const hadError = await brokenEnd.promise;

  sibling.end('hello');

  const replied = await siblingReply.promise;

  expect(hadError).toBe(false);
  expect(faulty.tunnels[0]?.isClosed).toBe(true);
  expect(replied).toBe('got hello');
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith('box:5432: impd broke the tunnel protocol');
});

test('#startProxy says impd restarted when impd closes an open tunnel to restart', async () => {
  const ctx = await setupTest();

  ctx.fake.agent.version = '0.18.0';

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.client.imps.create({ name: 'box' });

  const dialed = Promise.withResolvers<void>();

  const agent = await startStubAgent(buildImpPaths(ctx.dataDir, imp.id).vsockSocket, (socket) => {
    socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    dialed.resolve();
  });

  ctx.stack.defer(() => {
    agent.close();
  });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  const reply = sendLocalRequest('127.0.0.1', port, new Uint8Array(1));

  await dialed.promise;

  ctx.impd.api.closeExecSessions();

  expect(reply).rejects.toMatchObject({ code: 'ECONNRESET' });

  await waitFor(() => {
    expect(writeNotice).toHaveBeenCalledExactlyOnceWith('box:80: impd restarted');
  });
});

test('#startProxy prints one notice for a burst of connections that cannot reach impd', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => Date.UTC(2026, 0, 1) },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  await ctx.server.stop(true);

  const replies = await Promise.allSettled([
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
    sendLocalRequest('127.0.0.1', port, new Uint8Array(1)),
  ]);

  expect(replies.map((reply) => reply.status)).toStrictEqual(['rejected', 'rejected', 'rejected']);
  expect(writeNotice).toHaveBeenCalledExactlyOnceWith(`could not reach impd at ${ctx.url}`);
});

test('#startProxy prints the notice again once the quiet time passed without a failure', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const writeNotice = mock<(text: string) => void>();
  const clock = { nowMs: Date.UTC(2026, 0, 1) };

  const proxy = await startProxy(
    { url: ctx.url, token: ctx.rootToken, host: null },
    'box',
    [{ local: 0, remote: 80 }],
    { writeNotice, now: () => clock.nowMs },
  );

  ctx.stack.defer(() => {
    proxy.stop();
  });

  const [port] = proxy.ports;

  invariant(port !== undefined);

  await ctx.server.stop(true);
  await Promise.allSettled([sendLocalRequest('127.0.0.1', port, new Uint8Array(1))]);

  clock.nowMs += 5001;

  await Promise.allSettled([sendLocalRequest('127.0.0.1', port, new Uint8Array(1))]);

  expect(writeNotice.mock.calls).toStrictEqual([
    [`could not reach impd at ${ctx.url}`],
    [`could not reach impd at ${ctx.url}`],
  ]);
});

test('#runProxy prints the usage error for a proxy with no port and no reverse forward', async () => {
  const result = await runCLIInProcess({
    args: ['proxy', 'box'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: name a port to forward, or a --reverse forward\n',
    code: 2,
  });
});

test.each([
  [TUNNEL_CLOSE_LOST, 'the connection in the imp was lost'],
  [TUNNEL_CLOSE_RESTARTING, 'impd restarted'],
  [TUNNEL_CLOSE_PROTOCOL, 'impd broke the tunnel protocol'],
  [4999, 'impd closed the tunnel (code 4999)'],
])('#formatTunnelClose names close code %d as %s', (code, text) => {
  expect(formatTunnelClose(code)).toBe(text);
});
