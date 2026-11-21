import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { requireWithin } from './require-within';

test('it resolves with the value of a promise that settles within the time', async () => {
  const clock = createFakeClock();

  const value = await requireWithin(
    Promise.resolve(5),
    50,
    () => new Error('late'),
    clock.schedule,
  );

  expect(value).toBe(5);
});

test('it throws the built error for a promise still pending at the deadline', () => {
  const clock = createFakeClock();
  const waiting = requireWithin(new Promise(() => {}), 50, () => new Error('late'), clock.schedule);

  clock.advance(50);

  expect(waiting).rejects.toThrowWithMessage(Error, 'late');
});

test('it passes the rejection of the promise on', () => {
  const clock = createFakeClock();

  const waiting = requireWithin(
    Promise.reject(new Error('boom')),
    50,
    () => new Error('late'),
    clock.schedule,
  );

  expect(waiting).rejects.toThrowWithMessage(Error, 'boom');
});

test('it cancels its timer once the promise settles', async () => {
  const clock = createFakeClock();

  await requireWithin(Promise.resolve(), 50, () => new Error('late'), clock.schedule);

  expect(clock.countPending()).toBe(0);
});

test('it times out on a real timer by default', () => {
  const waiting = requireWithin(new Promise(() => {}), 1, () => new Error('late'));

  expect(waiting).rejects.toThrowWithMessage(Error, 'late');
});
