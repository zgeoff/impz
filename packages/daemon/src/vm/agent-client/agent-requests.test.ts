import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { create } from '@bufbuild/protobuf';
import {
  ActivitySchema,
  ErrorDataSchema,
  ErrorResponseSchema,
  FRAME_TYPES,
  OKSchema,
  PingSchema,
  SessionInfoSchema,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import invariant from 'tiny-invariant';
import { startStubAgent } from '../../../testing/vm/start-stub-agent';
import { openAgentConnection } from './agent-connection';
import {
  readFrameWithin,
  sendActivity,
  sendAgentRequest,
  sendFreeze,
  sendPing,
  sendSessionKill,
} from './agent-requests';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-vsock-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { vsockPath: join(directory, 'vsock.sock') };
}

test('#sendPing sends a ping through the CONNECT handshake', async () => {
  const ctx = setupTest();

  const agent = await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
        ok: true,
        version: '0.1.0',
        uptimeMs: 5,
      }),
    );
  });

  await sendPing(ctx.vsockPath);

  const [request] = agent.received;

  invariant(request);

  expect(decodeJsonPayload(request)).toStrictEqual({ op: 'ping' });
});

test("#sendPing resolves with the agent's answer", async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, PingSchema, {
        ok: true,
        version: '0.1.0',
        uptimeMs: 5,
      }),
    );
  });

  const ping = await sendPing(ctx.vsockPath);

  expect(ping).toStrictEqual(create(PingSchema, { ok: true, version: '0.1.0', uptimeMs: 5 }));
});

test('#sendAgentRequest rejects when the agent closes the connection without a response', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end();
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toThrowWithMessage(
    Error,
    'agent ping: no response',
  );
});

test('#sendAgentRequest rejects when the agent answers with a frame that is not a response', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode('early')));
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toThrowWithMessage(
    Error,
    'agent ping: no response',
  );
});

test('#readFrameWithin rejects when the agent does not answer within the timeout', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, () => {});

  const connection = await openAgentConnection(ctx.vsockPath);

  onTestFinished(() => {
    connection.close();
  });

  expect(readFrameWithin(connection, 1)).rejects.toThrowWithMessage(
    Error,
    'agent did not answer within 1 ms',
  );
});

test('#sendAgentRequest rejects with the error the agent answers', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: {
          code: 'INVALID_RESUME',
          message: 'offset 9999 is past the end',
          data: { end: 9000, bufferStart: 512 },
        },
      }),
    );
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toMatchObject({
    name: 'AgentError',
    code: 'INVALID_RESUME',
    detail: 'offset 9999 is past the end',
    data: create(ErrorDataSchema, { end: 9000, bufferStart: 512 }),
  });
});

test('#sendAgentRequest drops the fields of an error’s data it does not know', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        error: { code: 'BAD_REQUEST', message: 'missing op', data: { field: 'op' } },
      }),
    );
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    data: create(ErrorDataSchema),
  });
});

test('#sendAgentRequest keeps an error’s code when its data is not readable', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: {
          code: 'INVALID_RESUME',
          message: 'offset 9999 is past the end',
          data: { end: -1, bufferStart: 512 },
        },
      }),
    );
  });

  expect(sendAgentRequest(ctx.vsockPath, { op: 'ping' })).rejects.toMatchObject({
    name: 'AgentError',
    code: 'INVALID_RESUME',
    detail: 'offset 9999 is past the end',
    data: undefined,
  });
});

test.each([
  ['ok false', { ok: false }],
  ['no ok', {}],
])('#sendFreeze rejects an answer with %s', async (_label, answer) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    // plain JSON: the schema's encoder always writes ok, so it cannot leave it out
    socket.end(encodeJsonFrame(FRAME_TYPES.response, answer));
  });

  expect(sendFreeze(ctx.vsockPath, 1000)).rejects.toThrowWithMessage(
    Error,
    'imp.agent.v1.OK: the agent did not acknowledge the op',
  );
});

test('#sendFreeze resolves when the agent acknowledges the freeze', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
  });

  await expect(sendFreeze(ctx.vsockPath, 1000)).toResolve();
});

test('#sendActivity lists no sessions for an agent from before sessions', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, { tcp_established: 0, exec_sessions: 0, load1: 0 }),
    );
  });

  const activity = await sendActivity(ctx.vsockPath);

  expect(activity.sessions).toStrictEqual([]);
});

test.each([
  ['generation is a slash', { executionGeneration: '/' }],
  ['generation is a backslash', { executionGeneration: '\\' }],
  ['generation is a path with a slash', { executionGeneration: 'a/b' }],
  ['generation is a path with a backslash', { executionGeneration: String.raw`a\b` }],
  ['generation is the parent directory', { executionGeneration: '..' }],
  ['generation is the current directory', { executionGeneration: '.' }],
  ['generation is a relative traversal', { executionGeneration: '../../../evil' }],
  ['generation is a backslash traversal', { executionGeneration: String.raw`..\..\evil` }],
  ['generation is an absolute path', { executionGeneration: '/etc/passwd' }],
  ['generation is a drive path', { executionGeneration: String.raw`C:\evil` }],
  ['generation is a NUL', { executionGeneration: '\0' }],
  ['generation is a NUL inside a name', { executionGeneration: 'a\0b' }],
  ['generation is a value of 4096 characters', { executionGeneration: 'x'.repeat(4096) }],
  ['generation is 31 hex characters and a slash', { executionGeneration: `${'a'.repeat(31)}/` }],
  [
    'generation is 31 hex characters and a backslash',
    { executionGeneration: `${'a'.repeat(31)}\\` },
  ],
  [
    'generation is a traversal between hex characters',
    { executionGeneration: `${'a'.repeat(16)}/../${'a'.repeat(13)}` },
  ],
  ['generation is a slash and 31 hex characters', { executionGeneration: `/${'a'.repeat(31)}` }],
  ['generation is 31 hex characters and a NUL', { executionGeneration: `${'a'.repeat(31)}\0` }],
  ['generation is 31 hex characters', { executionGeneration: 'a'.repeat(31) }],
  ['generation is 33 hex characters', { executionGeneration: 'a'.repeat(33) }],
  ['generation is 32 uppercase hex characters', { executionGeneration: 'A'.repeat(32) }],
  ['generation is 32 letters that are not hex', { executionGeneration: 'g'.repeat(32) }],
  ['generation is a UUID', { executionGeneration: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a slash', { bootId: '/' }],
  ['boot id is a backslash', { bootId: '\\' }],
  ['boot id is a path with a slash', { bootId: 'a/b' }],
  ['boot id is a path with a backslash', { bootId: String.raw`a\b` }],
  ['boot id is the parent directory', { bootId: '..' }],
  ['boot id is the current directory', { bootId: '.' }],
  ['boot id is a relative traversal', { bootId: '../../../evil' }],
  ['boot id is a backslash traversal', { bootId: String.raw`..\..\evil` }],
  ['boot id is an absolute path', { bootId: '/etc/passwd' }],
  ['boot id is a drive path', { bootId: String.raw`C:\evil` }],
  ['boot id is a NUL', { bootId: '\0' }],
  ['boot id is a NUL inside a name', { bootId: 'a\0b' }],
  ['boot id is a value of 4096 characters', { bootId: 'x'.repeat(4096) }],
  ['boot id is a UUID that ends in a slash', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1/' }],
  [
    'boot id is a UUID that ends in a backslash',
    { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d1\\' },
  ],
  ['boot id is a traversal into a UUID', { bootId: '../c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID and a NUL', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11\0' }],
  ['boot id is a UUID one character short', { bootId: 'f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' }],
  ['boot id is a UUID one character long', { bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d110' }],
  ['boot id is an uppercase UUID', { bootId: '4F3C0F86-8F8B-4C45-A3B4-8E1C1E9B0D11' }],
  [
    'boot id is a UUID with a letter that is not hex',
    { bootId: '4g3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11' },
  ],
  ['boot id is a UUID without its dashes', { bootId: '4f3c0f868f8b4c45a3b48e1c1e9b0d11' }],
  ['session name is a slash', { name: '/' }],
  ['session name is a backslash', { name: '\\' }],
  ['session name is a path with a slash', { name: 'a/b' }],
  ['session name is a path with a backslash', { name: String.raw`a\b` }],
  ['session name is the parent directory', { name: '..' }],
  ['session name is the current directory', { name: '.' }],
  ['session name is a relative traversal', { name: '../../../evil' }],
  ['session name is a backslash traversal', { name: String.raw`..\..\evil` }],
  ['session name is an absolute path', { name: '/etc/passwd' }],
  ['session name is a drive path', { name: String.raw`C:\evil` }],
  ['session name is a NUL', { name: '\0' }],
  ['session name is a NUL inside a name', { name: 'a\0b' }],
  ['session name is a value of 4096 characters', { name: 'x'.repeat(4096) }],
  ['session name is an empty name', { name: '' }],
  ['session name is a name and a traversal', { name: 'main/..' }],
  ['session name is a name with a backslash', { name: String.raw`main\x` }],
  ['session name is a name and a NUL', { name: 'main\0' }],
  ['session name is a name of 33 characters', { name: 'a'.repeat(33) }],
  ['session name is an uppercase name', { name: 'Main' }],
  ['session name is a name that starts with a dash', { name: '-main' }],
  ['session name is a name with a dot', { name: 'main.log' }],
])('#sendActivity drops a session whose %s and keeps the rest', async (_label, forged) => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    const good = {
      name: 'main',
      pid: 1,
      argv: ['sh'],
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      startedUnixMs: 1,
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    };

    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ActivitySchema, {
        tcpEstablished: 0,
        execSessions: 0,
        load1: 0,
        sessions: [good, { ...good, ...forged }],
      }),
    );
  });

  const activity = await sendActivity(ctx.vsockPath);

  expect(activity.sessions).toStrictEqual([
    create(SessionInfoSchema, {
      name: 'main',
      pid: 1,
      argv: ['sh'],
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      startedUnixMs: 1,
      executionGeneration: '0123456789abcdef0123456789abcdef',
      bootId: '4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11',
      log: true,
    }),
  ]);
});

test('#sendActivity keeps a session without a generation, as an agent from before offsets lists it', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeJsonFrame(FRAME_TYPES.response, {
        tcp_established: 0,
        exec_sessions: 0,
        load1: 0,
        sessions: [
          {
            name: 'main',
            pid: 1,
            argv: ['sh'],
            state: 'running',
            attached: false,
            cols: 80,
            rows: 24,
            started_unix_ms: 1,
          },
        ],
      }),
    );
  });

  const activity = await sendActivity(ctx.vsockPath);

  expect(activity.sessions).toStrictEqual([
    create(SessionInfoSchema, {
      name: 'main',
      pid: 1,
      argv: ['sh'],
      state: 'running',
      attached: false,
      cols: 80,
      rows: 24,
      startedUnixMs: 1,
    }),
  ]);
});

test('#sendSessionKill rejects with NO_SESSION for a session that does not exist', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: { code: 'NO_SESSION', message: 'no session "main"' },
      }),
    );
  });

  expect(sendSessionKill(ctx.vsockPath, 'main')).rejects.toMatchObject({ code: 'NO_SESSION' });
});

test('#sendSessionKill rejects with AGENT_OUTDATED for an agent from before sessions', async () => {
  const ctx = setupTest();

  await startStubAgent(ctx.vsockPath, (socket) => {
    socket.end(
      encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
        error: { code: 'UNKNOWN_OP', message: 'unknown op' },
      }),
    );
  });

  expect(sendSessionKill(ctx.vsockPath, 'main')).rejects.toMatchObject({
    code: 'AGENT_OUTDATED',
  });
});
