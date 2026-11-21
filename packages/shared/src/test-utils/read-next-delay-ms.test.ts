import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { readNextDelayMs } from './read-next-delay-ms';

test('it reads what is left of the earliest timer after the clock moves', () => {
  const clock = createFakeClock();

  clock.schedule(() => {}, 900);
  clock.schedule(() => {}, 300);
  clock.advance(100);

  expect(readNextDelayMs(clock)).toBe(200);
});

test('it reads null when no timer is pending', () => {
  expect(readNextDelayMs(createFakeClock())).toBeNull();
});
