import { expect, spyOn, test } from 'bun:test';
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

test('it removes its listeners from the signal when it returns at once', async () => {
  const changes = createChangeSignal();

  const signal = new AbortController().signal;

  const added = spyOn(signal, 'addEventListener');
  const removed = spyOn(signal, 'removeEventListener');

  await waitForChange(changes, {
    read: () => Promise.resolve(2),
    isChanged: (current) => current > 1,
    signal,
  });

  expect(removed.mock.calls.map((call) => call[1])).toStrictEqual(
    added.mock.calls.map((call) => call[1]),
  );
});

test('it removes its listeners from the signal when its read throws', async () => {
  const changes = createChangeSignal();

  const signal = new AbortController().signal;

  const added = spyOn(signal, 'addEventListener');
  const removed = spyOn(signal, 'removeEventListener');

  const waiting = waitForChange(changes, {
    read: () => Promise.reject(new Error('disk gone')),
    isChanged: () => true,
    signal,
  });

  await expect(waiting).rejects.toThrow('disk gone');

  expect(removed.mock.calls.map((call) => call[1])).toStrictEqual(
    added.mock.calls.map((call) => call[1]),
  );
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
