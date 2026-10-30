import { expect, mock, test } from 'bun:test';
import { buildStubGatedCall } from './build-stub-gated-call';

test('it runs no real call before the gate opens', async () => {
  const real = mock(() => Promise.resolve('listed'));
  const gated = buildStubGatedCall(real);
  const pending = gated.call();

  await Promise.resolve();

  expect(real).not.toHaveBeenCalled();

  gated.open();

  await pending;
});

test('it answers every waiting call with the real call once the gate opens', async () => {
  const gated = buildStubGatedCall(() => Promise.resolve('listed'));
  const waiting = [gated.call(), gated.call()];

  gated.open();

  const answered = await Promise.all(waiting);

  expect(answered).toStrictEqual(['listed', 'listed']);
});

test('it runs a call made after the gate opened at once', async () => {
  const gated = buildStubGatedCall(() => Promise.resolve('listed'));

  gated.open();

  const answered = await gated.call();

  expect(answered).toBe('listed');
});
