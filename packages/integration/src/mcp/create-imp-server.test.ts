import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import {
  buildImpPaths,
  buildQueryGate,
  buildStubExecGuest,
  readImpByName,
  startStubExecAgent,
  startTestImpd,
} from '@impz/daemon/testing';
import { buildImpGuard } from '@impz/mcp';
import { PROTOCOL_VERSIONS } from '@impz/mcp/internal';
import { buildStubAfter } from '@impz/mcp/test-utils/build-stub-after';
import { buildStubRepeat } from '@impz/mcp/test-utils/build-stub-repeat';
import { createMcpServer } from '@impz/mcp/test-utils/create-mcp-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { INVALID_PARAMS, METHOD_NOT_FOUND } from '@modelcontextprotocol/server';
import invariant from 'tiny-invariant';
import * as z from 'zod';

async function setupTest() {
  const gate = buildQueryGate('imps');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    rootToken: 'root-token',
    frozenClockMs: Date.UTC(2026, 0, 1),
    wrapDatabase: (db) => gate.wrap(db),
  });

  const db = harness.db;
  const dataDir = harness.dataDir;
  const url = harness.url;
  const repeat = buildStubRepeat();
  const after = buildStubAfter();

  const mcp = createMcpServer({
    version: '1.2.3',
    killGraceMs: 50,
    progressIntervalMs: 1000,
    repeat: repeat.repeat,
    after: after.after,
  });

  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    createTestImage: harness.createTestImage,
    db,
    dataDir,
    stack,
    url,
    client: createImpClient({ url, token: 'root-token' }),
    mcp,
    repeat,
    after,
    gate,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test('it supports protocol versions 2025-11-25, 2025-06-18 and 2025-03-26, newest first', () => {
  expect(PROTOCOL_VERSIONS).toStrictEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
});

test.each([['2025-11-25'], ['2025-06-18'], ['2025-03-26']])(
  'it agrees on the protocol version %s',
  async (version) => {
    const ctx = await setupTest();

    const server = createMcpServer({ version: '1.2.3' });

    await server.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
      {
        reply: ctx.reply,
        client: ctx.client,
        guard: buildImpGuard({ all: true }),
        scope: 'manage',
      },
    );

    expect(ctx.sent).toStrictEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
          instructions: expect.any(String) as unknown,
        },
      },
    ]);
  },
);

test('it offers the newest protocol version for one it does not support', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
    { reply: ctx.reply, client: ctx.client, guard: buildImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
        instructions: expect.any(String) as unknown,
      },
    },
  ]);
});

test('it names the guard in the instructions it gives at initialize', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
    {
      reply: ctx.reply,
      client: ctx.client,
      guard: buildImpGuard({ prefix: 'agent-' }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'imp', title: 'imp', version: '1.2.3' },
        instructions: expect.stringContaining(
          'This server may touch imps named agent-*.',
        ) as unknown,
      },
    },
  ]);
});

test('it lists every tool to a manage caller', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ name: z.string() });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_create',
    'imp_destroy',
    'imp_sleep',
    'imp_url',
    'imp_fork',
    'imp_image_list',
    'imp_exec',
    'imp_read_file',
    'imp_write_file',
    'imp_checkpoint',
    'imp_checkpoint_list',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it marks the destructive tools with a destructive hint', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  const Annotations = z.object({ destructiveHint: z.boolean().optional() });
  const Tool = z.object({ name: z.string(), annotations: Annotations });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(
    tools.filter((tool) => tool.annotations.destructiveHint === true).map((tool) => tool.name),
  ).toStrictEqual([
    'imp_destroy',
    'imp_exec',
    'imp_write_file',
    'imp_restore',
    'imp_checkpoint_delete',
  ]);
});

test('it gives every tool an object input schema', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  const Tool = z.object({ inputSchema: z.object({ type: z.string() }) });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  expect(tools).toSatisfyAll((tool: (typeof tools)[number]) => tool.inputSchema.type === 'object');
});

test('it describes every input field of every tool', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  const Property = z.object({ description: z.string().optional() });
  const InputSchema = z.object({ properties: z.record(z.string(), Property).optional() });
  const Tool = z.object({ name: z.string(), inputSchema: InputSchema });

  const tools = z.object({ result: z.object({ tools: z.array(Tool) }) }).parse(ctx.sent[0])
    .result.tools;

  const undescribed = tools.flatMap((tool) =>
    Object.entries(tool.inputSchema.properties ?? {})
      .filter(([, property]) => property.description === undefined)
      .map(([field]) => `${tool.name}.${field}`),
  );

  expect(undescribed).toBeEmpty();
});

test('it answers ping with an empty result', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
});

test('it answers an unknown method with a method-not-found error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list' }), {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: METHOD_NOT_FOUND, message: 'unknown method: resources/list' },
    },
  ]);
});

test('it answers a call of an unknown tool with an invalid-params error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_teleport', arguments: {} },
    }),
    { reply: ctx.reply, client: ctx.client, guard: buildImpGuard({ all: true }), scope: 'manage' },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      error: { code: INVALID_PARAMS, message: 'unknown tool: imp_teleport' },
    },
  ]);
});

test('it refuses a call whose id a running call holds with an invalid-params error', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  ctx.gate.arm();

  const running = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await ctx.gate.reached;

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  const sentWhileRunning = [...ctx.sent];

  ctx.gate.release();

  await running;

  expect(sentWhileRunning).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 7,
      error: { code: INVALID_PARAMS, message: 'request 7 is already running' },
    },
  ]);
});

test('it still answers a create whose cancel arrives before the create starts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  await server.receive('{"jsonrpc":"2.0","id":0,"method":"ping"}', {
    ...context,
    reply: () => {},
  });

  const created = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: { name: 'box' } },
    }),
    context,
  );

  const cancelled = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    }),
    context,
  );

  await Promise.all([created, cancelled]);

  expect(ctx.sent).toMatchObject([
    {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: expect.any(String) as unknown }] },
    },
  ]);
});

test('it cancels the first call after refusing a second with its id', async () => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  const context = {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  } as const;

  ctx.gate.arm();

  const running = server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await ctx.gate.reached;

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'imp_list', arguments: {} },
    }),
    context,
  );

  await server.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 7 },
    }),
    context,
  );

  ctx.gate.release();

  await running;

  // The SDK sends no answer to a cancelled call.
  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 7,
      error: { code: INVALID_PARAMS, message: 'request 7 is already running' },
    },
  ]);
});

test.each([
  ['{"jsonrpc":"2.0","method":"notifications/initialized"}'],
  ['{"jsonrpc":"2.0","id":5,"result":{}}'],
])('it sends nothing for the message %s', async (line) => {
  const ctx = await setupTest();

  const server = createMcpServer({ version: '1.2.3' });

  await server.receive(line, {
    reply: ctx.reply,
    client: ctx.client,
    guard: buildImpGuard({ all: true }),
    scope: 'manage',
  });

  expect(ctx.sent).toBeEmpty();
});

test('it still answers a cancelled create, so the agent learns the name of what it made', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: buildImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_create', arguments: {} },
    }),
    context,
  );

  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const [made] = await ctx.client.imps.list();

  invariant(made);

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(made));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);
  expect(made.name).toStartWith('agent-');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
        },
        isError: false,
      },
    },
  ]);
});

test('it still answers a cancelled fork, so the agent learns the name of what it made', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'agent-src' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: buildImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_fork', arguments: { source: 'agent-src' } },
    }),
    context,
  );

  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const listed = await ctx.client.imps.list();

  const fork = listed.find((imp) => imp.name !== 'agent-src');

  invariant(fork);

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(fork));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);
  expect(fork.name).toStartWith('agent-');

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
          grantsNotCopied: [],
        },
        isError: false,
      },
    },
  ]);
});

test('it still answers a cancelled restore, so the agent learns the state of the imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'agent-src' });
  await ctx.client.checkpoints.create({ name: 'agent-src', label: 'cp' });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: buildImpGuard({ prefix: 'agent-' }),
    scope: 'manage' as const,
  };

  ctx.gate.arm();

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'agent-src', checkpoint: 'cp' } },
    }),
    context,
  );

  await ctx.gate.reached;

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }),
    context,
  );

  const sentAtCancel = [...ctx.sent];

  ctx.gate.release();

  await call;

  const restored = await ctx.client.imps.get({ name: 'agent-src' });

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(restored));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

  expect(sentAtCancel).toStrictEqual([]);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          imp: {
            ...stored,

            // its awake time runs on the wall clock between the answer and the read
            resources: { ...stored.resources, awakeMs: expect.any(Number) as unknown },
          },
        },
        isError: false,
      },
    },
  ]);
});

test('it stops reporting progress for a cancelled call', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const guest = buildStubExecGuest();

  await ctx.client.imps.create({ name: 'dev' });

  const record = await readImpByName(ctx.db, 'dev');

  invariant(record);

  const agent = await startStubExecAgent(buildImpPaths(ctx.dataDir, record.id).vsockSocket, guest);

  ctx.stack.defer(() => {
    agent.close();
  });

  const context = {
    reply: ctx.reply,
    client: createImpClient({ url: ctx.url, token: 'root-token' }),
    guard: buildImpGuard({ all: true }),
    scope: 'manage' as const,
  };

  const call = ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: {
        name: 'imp_exec',
        arguments: { name: 'dev', command: 'stubborn' },
        _meta: { progressToken: 'p' },
      },
    }),
    context,
  );

  await waitFor(() => {
    invariant(guest.requests[0]);
  });

  ctx.repeat.tick(1000);

  await ctx.mcp.receive(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } }),
    context,
  );

  ctx.repeat.tick(1000);

  await waitFor(() => {
    expect(ctx.after.countPending(50)).toBe(1);
  });

  ctx.after.fire(50);

  await call;

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progressToken: 'p',
        progress: 1,
        message: expect.stringMatching(/^still running after \d+ s$/u) as unknown,
      },
    },
  ]);
});
