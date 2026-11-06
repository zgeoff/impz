import { expect, test } from 'bun:test';
import { createChangeSignal } from './create-change-signal';
import { waitForChange } from './wait-for-change';

test('it returns the value at once when it has already changed', async () => {
  const changes = createChangeSignal();

  const value = await waitForChange(changes, {
    read: () => Promise.resolve(2),
    isChanged: (current) => current > 1,
    signal: new AbortController().signal,
  });

  expect(value).toBe(2);
});

test('it reads again after a notify and returns the changed value', async () => {
  const changes = createChangeSignal();
  const store = { value: 1 };

  const waiting = waitForChange(changes, {
    read: () => Promise.resolve(store.value),
    isChanged: (current) => current > 1,
    signal: new AbortController().signal,
  });

  await Promise.resolve();

  store.value = 2;

  changes.notify();

  const value = await waiting;

  expect(value).toBe(2);
});

test('it sees a notify that lands between its read and its wait', async () => {
  const changes = createChangeSignal();
  const reads = [1, 2];

  const value = await waitForChange(changes, {
    read: () => {
      const current = reads.shift() ?? 0;

      changes.notify();

      return Promise.resolve(current);
    },
    isChanged: (current) => current > 1,
    signal: new AbortController().signal,
  });

  expect(value).toBe(2);
});

test('it returns the unchanged value when its signal aborts', async () => {
  const changes = createChangeSignal();

  const controller = new AbortController();

  const waiting = waitForChange(changes, {
    read: () => Promise.resolve(1),
    isChanged: (current) => current > 1,
    signal: controller.signal,
  });

  controller.abort();

  const value = await waiting;

  expect(value).toBe(1);
});
