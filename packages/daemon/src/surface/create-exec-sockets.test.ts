import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../../testing/start-test-impd';
import { tryExecSocket } from '../../testing/surface/try-impd-sockets';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { rootToken: 'root-token' });

  return { port: new URL(harness.url).port };
}

test.each([
  ['no ticket and no token', '', {}],
  ['the token in the query', 'token=root-token', {}],
  ['a ticket impd never issued', 'ticket=not-a-ticket', {}],
  ['an empty ticket', 'ticket=', {}],
  [
    'a ticket impd never issued beside a valid bearer',
    'ticket=not-a-ticket',
    { authorization: 'Bearer root-token' },
  ],
  ['a bearer token impd does not know', '', { authorization: 'Bearer not-a-token' }],
  ['a bearer header with no token', '', { authorization: 'Bearer' }],
  ['the token under the basic scheme', '', { authorization: 'Basic cm9vdC10b2tlbg==' }],
])('it refuses an exec socket with %s', async (_label, query, headers) => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, query, 'dev', headers);

  expect(reply).toBe('rejected');
});

test('it opens an exec socket for a valid bearer token', async () => {
  const ctx = await setupTest();
  const reply = await tryExecSocket(ctx.port, '', 'dev', { authorization: 'Bearer root-token' });

  expect(JSON.parse(reply)).toMatchObject({ type: 'error', code: 'NOT_FOUND' });
});
