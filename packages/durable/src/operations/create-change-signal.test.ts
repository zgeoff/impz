import { expect, test } from 'bun:test';
import { setImmediate } from 'node:timers/promises';
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

test('it leaves a wait that starts after a notify pending until the next notify', async () => {
  const changes = createChangeSignal();
  const settled: string[] = [];

  changes.notify();

  const waiting = (async () => {
    await changes.next(new AbortController().signal);

    settled.push('notified');
  })();

  await setImmediate();

  const beforeNotify = [...settled];

  changes.notify();

  await waiting;

  expect({ beforeNotify, afterNotify: settled }).toStrictEqual({
    beforeNotify: [],
    afterNotify: ['notified'],
  });
});
