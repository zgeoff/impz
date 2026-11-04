import { expect, onTestFinished, test } from 'bun:test';
import { startStubImpdRelease } from './start-stub-impd-release';

test('it serves the other release’s answers on a loopback port', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const older = startStubImpdRelease(
    stack,
    () => Promise.resolve(Response.json({ json: { features: { sessionLog: true } }, meta: [] })),
    { withoutFeatures: ['sessionLog'] },
  );

  const response = await fetch(`${older.url}/rpc/system/info`, { method: 'POST' });
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ json: { features: {} }, meta: [] });
  expect(older.calls).toStrictEqual(['system/info']);
});

test('it stops listening once the stack is released', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const older = startStubImpdRelease(stack, () => Promise.resolve(new Response('{}')));

  await stack.disposeAsync();

  expect(fetch(`${older.url}/rpc/system/info`, { method: 'POST' })).rejects.toThrow();
});
