import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { buildAdvancingClock } from './build-advancing-clock';

test('it moves the clock by the whole wait of a sleep, fires the timers due in it, and notes the delay', async () => {
  const clock = createFakeClock();
  const fired: number[] = [];

  clock.schedule(() => {
    fired.push(clock.now());
  }, 300);

  await buildAdvancingClock(clock).sleep(500);

  expect({ nowMs: clock.now(), fired, delays: clock.delays }).toStrictEqual({
    nowMs: 500,
    fired: [300],
    delays: [300, 500],
  });
});

test('it reads the time of the fake clock', () => {
  const clock = createFakeClock({ startMs: 1234 });

  expect(buildAdvancingClock(clock).now()).toBe(1234);
});
