import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { EXEC_MAX_STDIN_FRAME_BYTES, EXEC_STDIN_WINDOW_BYTES } from '@impz/api';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@impz/daemon/src/agent-client/frame-codec';
import { createImage } from '@impz/daemon/src/db/images';
import { readVmIdentity, writeVmIdentity } from '@impz/daemon/src/sleep/vm-identity';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildStubExecReplies,
  startStubAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { listLocalEntries, writeLocalEntries } from '@impz/local-tar';
import { waitFor } from '@impz/test-utils/wait-for';
import tar from 'tar-stream';
import invariant from 'tiny-invariant';
import { createImpClient } from '../create-imp-client';
import { buildStubExecPeer } from '../test-utils/build-stub-exec-peer';
import { openToolExec } from './open-tool-exec';

// impd, booted on stand-ins and listening on a loopback port, and the root
// token's client and config for it
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // impd boots with a root bearer; each test's config sends it
  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, { rootToken });

  const url = harness.url;

  // the image a test's imp boots from, with a rootfs where its digest names
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

test('it sends an archive whole through impd to the imp’s tool and returns its exit code', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with impz cp
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  const archive = tar.extract();
  const names: string[] = [];

  const reading = (async () => {
    for await (const entry of archive) {
      names.push(
        `${entry.header.name} ${entry.header.type} ${(entry.header.mode & 0o777).toString(8)}`,
      );

      entry.resume();
    }
  })();

  const agent = await startStubAgent(
    paths.vsockSocket,
    buildStubExecReplies({
      started: [encodeJsonFrame(FRAME_TYPES.started, { pid: 9 })],
      exited: [encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 })],
      onStdin: (payload) => {
        archive.write(payload);
      },
      onStdinEnd: () => {
        archive.end(null);
      },
    }),
  );

  const dir = await mkdtemp(join(tmpdir(), 'open-tool-exec-'));

  onTestFinished(() => rm(dir, { recursive: true, force: true }));

  await mkdir(join(dir, 'proj'), { mode: 0o750 });

  await writeFile(join(dir, 'proj', 'big.bin'), new Uint8Array(4 * EXEC_STDIN_WINDOW_BYTES), {
    mode: 0o600,
  });

  await symlink('big.bin', join(dir, 'proj', 'link'));

  const entries = await listLocalEntries(join(dir, 'proj'));

  const exec = await openToolExec({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
  });

  await writeLocalEntries(entries, exec.writeStdin, { add: () => {} }, () => {});

  exec.endStdin();

  const code = await exec.waitExit();

  await reading;

  const [request] = agent.received;

  invariant(request);

  expect(code).toBe(0);

  expect(decodeJsonPayload(request)).toStrictEqual({
    op: 'exec',
    argv: ['/run/imp/sys/imp-agent', 'tar', 'extract', '/srv/proj'],
    tty: false,
    user: 'root',
  });

  expect(names).toStrictEqual([
    'proj/ directory 750',
    'proj/big.bin file 600',
    'proj/link symlink 777',
  ]);
});

test('it rejects with impd’s code and message when impd refuses the exec', async () => {
  const ctx = await setupTest();

  await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the stub VMM records an agent from before impz cp
  const opening = openToolExec({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
  });

  expect(opening).rejects.toThrowWithMessage(
    Error,
    "AGENT_OUTDATED: the imp's agent has no imp cp yet; stop and start the imp to update it",
  );
});

// on the exec peer: a real impd withholds stdin acks only while the agent's
// socket is backed up, and how many bytes that takes is not fixed
test('it holds stdin at the window when impd withholds its acks', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
    }
  });

  const exec = await openToolExec({
    baseUrl: 'http://impd.test',
    token: 'root-token',
    name: 'box',
    tool: 'tar',
    args: ['extract', '/srv/proj'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(exec.close);

  // a window and two frames: the last frame needs an ack to go
  const writing = exec.writeStdin(
    new Uint8Array(EXEC_STDIN_WINDOW_BYTES + 2 * EXEC_MAX_STDIN_FRAME_BYTES),
  );

  await waitFor(() => {
    expect(
      peer.received.reduce((total, message) => total + ('bytes' in message ? message.bytes : 0), 0),
    ).toBe(EXEC_STDIN_WINDOW_BYTES + EXEC_MAX_STDIN_FRAME_BYTES);
  });

  expect(Bun.peek.status(writing)).toBe('pending');

  expect(
    peer.received.flatMap((message) => (message.type === 'stdin' ? [message.bytes] : [])),
  ).toSatisfyAll((bytes: number) => bytes <= EXEC_MAX_STDIN_FRAME_BYTES);
});

// on the exec peer: the frames impd forwards in one write, and so the acks
// in flight, depend on the socket's timing
test('it holds its stdout ack while the caller is still writing the output', async () => {
  const peer = buildStubExecPeer((link, message) => {
    if (message.type === 'start') {
      link.send({ type: 'started', pid: 9 });
      link.sendFrame(1, 'x'.repeat(300));
      link.sendFrame(1, 'y'.repeat(200));
    }
  });

  const seen: number[] = [];
  const writing = Promise.withResolvers<void>();

  const exec = await openToolExec({
    baseUrl: 'http://impd.test',
    token: 'root-token',
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: async (data) => {
      seen.push(data.byteLength);

      await writing.promise;
    },
    onStderr: () => {},
    connect: peer.connect,
  });

  onTestFinished(() => {
    writing.resolve();
    exec.close();
  });

  await waitFor(() => {
    expect(seen).toStrictEqual([300, 200]);
  });

  expect(peer.received).toStrictEqual([
    { type: 'start', name: 'box', tool: 'tar', argv: ['create', 'x'], tty: false },
  ]);
});

test('it acks a tool’s stdout to impd so a download past the window completes', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with impz cp
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  // three 512 KiB frames: past impd's 1 MiB window, so the exit reaches the
  // client only after its acks reached impd
  const frame = new Uint8Array(512 * 1024).fill(7);

  await startStubAgent(paths.vsockSocket, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
      socket.write(encodeFrame(FRAME_TYPES.stdout, frame));
      socket.write(encodeFrame(FRAME_TYPES.stdout, frame));
      socket.write(encodeFrame(FRAME_TYPES.stdout, frame));
      socket.write(encodeJsonFrame(FRAME_TYPES.exit, { code: 0, signal: 0 }));
    }
  });

  const chunks: Uint8Array[] = [];

  const exec = await openToolExec({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    name: 'box',
    tool: 'tar',
    args: ['create', '/srv/proj'],
    onStdout: (data) => {
      chunks.push(new Uint8Array(data));

      return Promise.resolve();
    },
    onStderr: () => {},
  });

  exec.endStdin();

  const code = await exec.waitExit();

  expect(code).toBe(0);
  expect(Buffer.concat(chunks)).toStrictEqual(Buffer.alloc(3 * 512 * 1024, 7));
});

test('it rejects and closes the socket when impd faults with a message the protocol does not know', async () => {
  const peer = buildStubExecPeer((link) => {
    link.sendText(JSON.stringify({ type: 'progress', percent: 50 }));
  });

  const opening = openToolExec({
    baseUrl: 'http://impd.test',
    token: 'root-token',
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  expect(opening).rejects.toThrowWithMessage(Error, 'impd sent a message the client does not know');

  await expect(peer.closed).toResolve();
});

test('it rejects and names impd when impd faults by closing the connection unanswered', () => {
  const peer = buildStubExecPeer((link) => {
    link.close(1011, 'gone');
  });

  const opening = openToolExec({
    baseUrl: 'http://impd.test',
    token: 'root-token',
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
    connect: peer.connect,
  });

  expect(opening).rejects.toThrowWithMessage(
    Error,
    'the connection to impd at http://impd.test closed',
  );
});

test('it rejects with impd’s message when the imp’s agent drops the exec after the start', async () => {
  const ctx = await setupTest();
  const imp = await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const paths = buildImpPaths(ctx.dataDir, imp.id);
  const identity = readVmIdentity(paths);

  invariant(identity);

  // an agent with impz cp
  writeVmIdentity(paths, { ...identity, agentVersion: '0.18.0' });

  await startStubAgent(paths.vsockSocket, (socket, _request, frames) => {
    if (frames.length === 1) {
      socket.write(encodeJsonFrame(FRAME_TYPES.started, { pid: 9 }));
    } else if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
      socket.end();
    }
  });

  const exec = await openToolExec({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
    name: 'box',
    tool: 'tar',
    args: ['create', 'x'],
    onStdout: () => Promise.resolve(),
    onStderr: () => {},
  });

  exec.endStdin();

  expect(exec.waitExit()).rejects.toThrowWithMessage(
    Error,
    'error: the agent connection closed before the process exited',
  );
});
