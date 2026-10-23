import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../../testing/start-test-impd';
import { tryTunnelSocket } from '../../testing/surface/try-impd-sockets';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  return { port: new URL(harness.url).port };
}

test.each([
  ['no token', '', {}],
  ['the token in the query', 'token=root-token', {}],
  ['a ticket in place of a token', 'ticket=not-a-ticket', {}],
  ['a bearer token impd does not know', '', { authorization: 'Bearer not-a-token' }],
  ['a bearer header with no token', '', { authorization: 'Bearer' }],
  ['the token under the basic scheme', '', { authorization: 'Basic cm9vdC10b2tlbg==' }],
])('it refuses a tunnel socket with %s', async (_label, query, headers) => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, query, headers);

  expect(reply).toBe('rejected');
});

test('it opens a tunnel socket for a valid bearer token', async () => {
  const ctx = await setupTest();
  const reply = await tryTunnelSocket(ctx.port, '', { authorization: 'Bearer root-token' });

  expect(JSON.parse(reply)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
});
