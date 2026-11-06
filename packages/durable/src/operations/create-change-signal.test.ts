import { expect, test } from 'bun:test';
import { createChangeSignal } from './create-change-signal';

test('it settles a wait on the next notify', async () => {
  const changes = createChangeSignal();
  const next = changes.next(new AbortController().signal);

  changes.notify();

  await expect(next).toResolve();
});

test('it settles a wait when its signal aborts', async () => {
  const changes = createChangeSignal();

  const controller = new AbortController();

  const next = changes.next(controller.signal);

  controller.abort();

  await expect(next).toResolve();
});

test('it settles a wait at once for a signal that already aborted', async () => {
  const changes = createChangeSignal();
  const next = changes.next(AbortSignal.abort());

  await expect(next).toResolve();
});

test('it leaves a wait that starts after a notify for the next notify', async () => {
  const changes = createChangeSignal();

  changes.notify();

  const first = await Promise.race([
    changes.next(new AbortController().signal).then(() => 'notified'),
    Promise.resolve('waiting'),
  ]);

  expect(first).toBe('waiting');
});
