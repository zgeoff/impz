import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { startTestImpd } from '@impz/daemon/test-utils';
import { buildImpGuard } from '../imp-guard';
import { createMcpServer } from '../test-utils/create-mcp-server';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

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

test('it lists the events after a cursor of the imps its guard allows', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.rootClient.imps.create({ name: 'home-dev' });
  await ctx.rootClient.imps.create({ name: 'other' });

  const seen = await ctx.rootClient.events.list({});

  await ctx.rootClient.imps.sleep({ name: 'home-dev' });
  await ctx.rootClient.imps.sleep({ name: 'other' });

  const unguarded = await ctx.rootClient.events.list({ after: seen.after, logId: seen.logId });

  await ctx.mcp.receive(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'imp_event_list', arguments: { after: seen.after, logId: seen.logId } },
    }),
    {
      reply: ctx.reply,
      client: createImpClient({
        url: 'http://impd.test',
        token: 'root-token',
        fetch: ctx.sendToImpd,
      }),
      guard: buildImpGuard({ prefix: 'home-' }),
      scope: 'read',
    },
  );

  expect(ctx.sent).toStrictEqual([
    {
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: expect.any(String) as unknown }],
        structuredContent: {
          events: [
            expect.objectContaining({
              ev: 'ImpChanged',
              reason: 'slept',
              imp: expect.objectContaining({ name: 'home-dev' }) as unknown,
            }) as unknown,
          ],
          after: unguarded.after,
          logId: seen.logId,
          hasMore: false,
        },
        isError: false,
      },
    },
  ]);
});
