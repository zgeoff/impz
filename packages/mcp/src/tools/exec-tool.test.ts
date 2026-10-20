import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/platform/db/images';
import { findImpByName } from '@impz/daemon/src/platform/db/imps';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  buildStubExecGuest,
  startStubExecAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { createImpGuard } from '../imp-guard';
import { buildStubAfter } from '../test-utils/build-stub-after';
import { buildStubRepeat } from '../test-utils/build-stub-repeat';
import { createMcpServer } from '../test-utils/create-mcp-server';

// impd's real app on a loopback port for an exec's socket, a root client,
// `stack`, whose releases run before impd stops, and an MCP server whose
// messages land parsed in `sent`, its progress stepped by `repeat`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // the bearer the root client sends
  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  const db = harness.db;
  const dataDir = harness.dataDir;
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  // the image every imps.create boots when it names none
  await Bun.write(buildImagePaths(dataDir, image.digest).rootfs, 'rootfs');

  await createImage(db, image);

  const url = harness.url;
  const repeat = buildStubRepeat();
  const after = buildStubAfter();

  // progress ticks only when the test steps `repeat` by 1000 ms; a command's
  // deadline and its 50 ms kill grace end only when the test fires `after`
  const mcp = createMcpServer({
    version: '1.2.3',
    killGraceMs: 50,
    progressIntervalMs: 1000,
    repeat: repeat.repeat,
    after: after.after,
  });

  // its calls in flight end before impd's app closes
  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    db,
    dataDir,
    stack,
    url,
    rootClient: createImpClient({ url, token: 'root-token' }),
    mcp,
    repeat,
    after,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it runs a command line through /bin/sh -c and returns its output', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'echo hi', cwd: '/srv', env: { A: '1' } },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'hi\n',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([
    { argv: ['/bin/sh', '-c', 'echo hi'], cwd: '/srv', env: ['A=1'] },
  ]);
});

test('it runs argv as it is, with stdin', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['cat'], stdin: 'piped' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'piped',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([{ argv: ['cat'] }]);
});

test('it answers a non-zero exit as a result, not a tool error', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['fail'] } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 3,
          signal: null,
          timedOut: false,
          stdout: 'partial',
          stderr: 'boom',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test("it passes a requirement to impd, whose refusal comes back as the tool's error", async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], require: ['broker'] } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the imp holds no grant, so impd sets no broker variables and runs nothing
  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: 'PRECONDITION_FAILED: the broker is not ready for this exec: the imp has no grant, so impd sets no broker variables',
          },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it runs a command whose broker requirement impd meets, with the broker variables', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-1' });
  await ctx.rootClient.grants.add({ name: 'dev', secret: 'gh' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', argv: ['echo', 'hi'], require: ['broker'] },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'hi\n',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([
    {
      argv: ['echo', 'hi'],
      env: expect.arrayContaining([expect.stringMatching(/^HTTPS_PROXY=http:\/\//u)]) as unknown,
    },
  ]);
});

test('it refuses an unknown requirement before anything runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], require: ['net'] } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringMatching(/^invalid arguments: .*require/su) as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it refuses a call with neither command nor argv', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('give either command or argv') as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);
});

test('it refuses a call with both command and argv', async () => {
  const ctx = await setupTest();

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'x', argv: ['x'] } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          {
            type: 'text',
            text: expect.stringContaining('give either command or argv') as unknown,
          },
        ],
        isError: true,
      },
    },
  ]);
});

test('it refuses an outer exec in the agent, and nothing runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', argv: ['ls'], outer: true } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: expect.stringMatching(/^invalid arguments: .*outer/su) as unknown },
        ],
        isError: true,
      },
    },
  ]);

  expect(guest.requests).toStrictEqual([]);
});

test('it keeps the head and the tail of a large output and counts what it dropped', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'flood 1000000', maxOutputBytes: 16_384 },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // 8 KiB of head and 8 KiB of tail around the marker; `flood` fills
  // between HEAD and TAIL with x
  const stdout = [
    `HEAD${'x'.repeat(8192 - 4)}`,
    `\n[... ${String(1_000_000 - 16_384)} bytes dropped ...]\n`,
    `${'x'.repeat(8192 - 4)}TAIL`,
  ].join('');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout,
          stderr: '',
          stdoutDroppedBytes: 1_000_000 - 16_384,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test('it sends SIGTERM to a command at its timeout and reports timedOut', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  // the default timers, as `impz mcp` runs them: the shortest timeout is a
  // second; its close runs before impd stops
  const mcp = createMcpServer({ version: '1.2.3', killGraceMs: 50 });

  ctx.stack.defer(() => mcp.close());

  await mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy', timeoutSeconds: 1 },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.signals).toStrictEqual(['sleepy:15']);

  // the agent kills what is left of the group itself, given the grace: no
  // second exec
  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'sleepy'], killGraceMs: 50 }]);
});

// before protocol 0.8.0 the rest of the group outlives the stop until the
// imp restarts (docs/guides/operations.md#upgrade)
test('it opens no second exec to stop a command on an agent from before the group kill', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest({ oldAgent: true });

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy', timeoutSeconds: 1 },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the command's deadline, once the guest runs it
  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  ctx.after.fire(1000);

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGTERM',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'sleepy'] }]);
});

test('it sends SIGKILL after the grace to a command that ignores SIGTERM', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'stubborn', timeoutSeconds: 1 },
      },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the command's deadline, once the guest runs it, then the grace SIGTERM
  // opens
  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  ctx.after.fire(1000);

  await waitFor(() => {
    expect(ctx.after.countPending(50)).toBe(1);
  });

  ctx.after.fire(50);

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: null,
          signal: 'SIGKILL',
          timedOut: true,
          stdout: '',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);

  expect(guest.signals).toStrictEqual(['stubborn:15', 'stubborn:9']);

  // the session carried SIGKILL to the whole group: no sweep
  expect(guest.requests).toMatchObject([{ argv: ['/bin/sh', '-c', 'stubborn'] }]);
});

test('it stops a cancelled exec and sends no response', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ all: true }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'stubborn' } },
    }),
    context,
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7, reason: 'user' },
    }),
    context,
  );

  // the grace SIGTERM opens, which the stubborn command outlasts
  await waitFor(() => {
    expect(ctx.after.countPending(50)).toBe(1);
  });

  ctx.after.fire(50);

  await call;

  expect(ctx.sent).toStrictEqual([]);
  expect(guest.signals).toStrictEqual(['stubborn:15', 'stubborn:9']);
});

test('it stops every call in flight on close, as when the client goes away', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'sleepy' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  await ctx.mcp.close();

  await call;

  expect(ctx.sent).toStrictEqual([]);
  expect(guest.signals).toStrictEqual(['sleepy:15']);
});

test('it sends a progress notification on each tick while a call with a progress token runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: createImpGuard({ all: true }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'sleepy' },
        _meta: { progressToken: 'p1' },
      },
    }),
    context,
  );

  // the command runs in the guest
  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  ctx.repeat.tick(1000);
  ctx.repeat.tick(1000);

  // the cancel ends the call, which then sends nothing more
  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p1',
        progress: 1,
        message: expect.stringMatching(/^still running after \d+ s$/u) as unknown,
      },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p1',
        progress: 2,
        message: expect.stringMatching(/^still running after \d+ s$/u) as unknown,
      },
    },
  ]);
});

test('it boots a stopped imp for an exec', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.rootClient.imps.stop({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'echo up' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: 'up\n',
          stderr: '',
          stdoutDroppedBytes: 0,
          stderrDroppedBytes: 0,
        },
        isError: false,
      },
    },
  ]);
});

test('it leaves a stopped imp running after an exec', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();

  await ctx.rootClient.imps.create({ name: 'dev' });

  const record = await findImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  await ctx.rootClient.imps.stop({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_exec', arguments: { name: 'dev', command: 'echo up' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({ url: ctx.url, token: 'root-token' }),
      guard: createImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const imp = await ctx.rootClient.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
});
