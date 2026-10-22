import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { startTestImpd } from '@impz/daemon/testing';
import { buildImpGuard } from '@impz/mcp';
import { createMcpServer } from '@impz/mcp/test-utils/create-mcp-server';
import * as z from 'zod';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    rootToken: 'root-token',
    frozenClockMs: Date.UTC(2026, 0, 1),
  });

  const sendToImpd = (request: Request) => harness.impd.api.app.handle(request);
  const mcp = createMcpServer({ version: '1.2.3' });

  stack.defer(() => mcp.close());

  const sent: unknown[] = [];

  return {
    createTestImage: harness.createTestImage,
    rootClient: createImpClient({
      url: 'http://impd.test',
      token: 'root-token',
      fetch: sendToImpd,
    }),
    sendToImpd,
    mcp,
    sent,
    reply: (message: string) => {
      sent.push(JSON.parse(message));
    },
  };
}

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it takes a checkpoint of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'dev' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint', arguments: { name: 'dev', label: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const checkpoints = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const stored: unknown = JSON.parse(JSON.stringify(checkpoints[0]));

  expect(checkpoints).toHaveLength(1);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { checkpoint: stored },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it lists the checkpoints of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint_list', arguments: { name: 'dev' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ all: true }),
      scope: 'read',
    },
  );

  const checkpoints = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const stored: unknown = JSON.parse(JSON.stringify(checkpoints));

  expect(checkpoints).toPartiallyContain({ label: 'cp1' });

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: { checkpoints: stored },
        isError: false,
      },
    },
  ]);
});

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it restores %s imp to a checkpoint', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'dev', checkpoint: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const restored = await ctx.rootClient.imps.get({ name: 'dev' });

  // oxlint-disable-next-line prefer-structured-clone -- the JSON round trip is the point
  const json: unknown = JSON.parse(JSON.stringify(restored));
  const stored = z.looseObject({ resources: z.looseObject({}) }).parse(json);

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

test.each([
  ['a running', []],
  ['a sleeping', ['sleep']],
  ['a stopped', ['stop']],
] as const)('it deletes a checkpoint of %s imp', async (_state, transitions) => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'dev' });
  await ctx.rootClient.checkpoints.create({ name: 'dev', label: 'cp1' });

  for (const transition of transitions) {
    await ctx.rootClient.imps[transition]({ name: 'dev' });
  }

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_checkpoint_delete', arguments: { name: 'dev', checkpoint: 'cp1' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  const remaining = await ctx.rootClient.checkpoints.list({ name: 'dev' });

  expect(remaining).toStrictEqual([]);

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: '{\n  "deleted": "cp1"\n}' }],
        structuredContent: { deleted: 'cp1' },
        isError: false,
      },
    },
  ]);
});

test('it answers a restore to a checkpoint that does not exist with an isError result', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'dev' });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_restore', arguments: { name: 'dev', checkpoint: 'nope' } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ all: true }),
      scope: 'manage',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.stringMatching(/^NOT_FOUND: /u) as unknown }],
        isError: true,
      },
    },
  ]);
});
