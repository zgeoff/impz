import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { fireNextTimer } from './fire-next-timer';

test('it fires the earliest timer only and moves the clock to its time', () => {
  const clock = createFakeClock({ startMs: 100 });
  const fired: string[] = [];

  clock.schedule(() => {
    fired.push('late');
  }, 500);

  clock.schedule(() => {
    fired.push('early');
  }, 200);

  fireNextTimer(clock);

  expect({ fired, nowMs: clock.now(), pending: clock.countPending() }).toStrictEqual({
    fired: ['early'],
    nowMs: 300,
    pending: 1,
  });
});

test('it does nothing when no timer is pending', () => {
  const clock = createFakeClock({ startMs: 100 });

  fireNextTimer(clock);

  expect(clock.now()).toBe(100);
});
