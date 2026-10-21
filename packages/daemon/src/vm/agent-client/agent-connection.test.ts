import { expect, onTestFinished, test } from 'bun:test';
import { linkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FRAME_TYPES, encodeJsonFrame } from '@impz/agent-protocol';
import { startStubAgent } from '../../../testing/vm/start-stub-agent';
import { openAgentConnection } from './agent-connection';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-vsock-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { vsockPath: join(directory, 'vsock.sock') };
}

test('it hands over the frames the agent sends after its OK', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
  });

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  connection.sendJson(FRAME_TYPES.request, { op: 'ping' });

  const frame = await connection.next();

  expect(frame).toStrictEqual({
    type: FRAME_TYPES.response,
    payload: new TextEncoder().encode('{"ok":true}'),
  });
});

test('it rejects a handshake that Firecracker refuses', async () => {
  const ctx = setupTest();

  const server = createServer((socket) => {
    socket.end('FAILURE\n');
  });

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    'vsock handshake refused: "FAILURE"',
  );
});

test('it rejects when the socket closes during the handshake', async () => {
  const ctx = setupTest();

  const server = createServer((socket) => {
    socket.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    'vsock closed during the handshake',
  );
});

test('it rejects when the handshake gets no answer within the timeout', async () => {
  const ctx = setupTest();
  const server = createServer(() => {});

  await new Promise<void>((resolve) => {
    server.listen(ctx.vsockPath, resolve);
  });

  onTestFinished(() => {
    server.close();
  });

  expect(openAgentConnection(ctx.vsockPath, 1)).rejects.toThrowWithMessage(
    Error,
    'vsock handshake timed out after 1 ms',
  );
});

test('it rejects with the connect error when nothing listens on the vsock socket', async () => {
  const ctx = setupTest();

  // A hard link to a unix socket file outlives the server's listener on it.
  const server = createServer(() => {});
  const listenPath = `${ctx.vsockPath}.listen`;

  await new Promise<void>((resolve) => {
    server.listen(listenPath, resolve);
  });

  // Node hands the close callback an error when the server is already closed.
  onTestFinished(() => {
    server.close(() => {});
  });

  linkSync(listenPath, ctx.vsockPath);

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });

  expect(openAgentConnection(ctx.vsockPath)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});

test('it rejects a vsock path that is not a socket', () => {
  const ctx = setupTest();

  writeFileSync(ctx.vsockPath, '');

  expect(openAgentConnection(ctx.vsockPath)).rejects.toThrowWithMessage(
    Error,
    `${ctx.vsockPath} is not a socket`,
  );
});
