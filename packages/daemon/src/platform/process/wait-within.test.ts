import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { waitWithin } from './wait-within';

test('it resolves true for a promise that settles within the time', async () => {
  const isSettled = await waitWithin(Promise.resolve(), 50);

  expect(isSettled).toBeTrue();
});

test('it resolves false for a promise still pending at the deadline', async () => {
  const isSettled = await waitWithin(new Promise(() => {}), 1);

  expect(isSettled).toBeFalse();
});

test('it resolves false at the deadline of the timer it is passed', async () => {
  const clock = createFakeClock();
  const waiting = waitWithin(new Promise(() => {}), 50, clock.schedule);

  clock.advance(50);

  const isSettled = await waiting;

  expect(isSettled).toBeFalse();
});

test('it passes the rejection of the promise on', () => {
  const failed = Promise.reject(new Error('boom'));

  expect(waitWithin(failed, 50)).rejects.toThrowWithMessage(Error, 'boom');
});
