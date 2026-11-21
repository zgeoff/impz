import { expect, test } from 'bun:test';
import { createFakeClock } from '@zgeoff/testing/clock';
import { awaitWithClock } from './await-with-clock';

test('it returns what work that sleeps on the clock returns, without real waiting', async () => {
  const clock = createFakeClock();

  const work = (async () => {
    await clock.sleep(5000);
    await clock.sleep(7000);

    return 'done';
  })();

  const result = await awaitWithClock(clock, work);

  expect(result).toBe('done');
  expect(clock.now()).toBe(12_000);
});

test('it throws what the work throws', () => {
  const clock = createFakeClock();

  const work = (async () => {
    await clock.sleep(10);

    throw new Error('gave up');
  })();

  expect(awaitWithClock(clock, work)).rejects.toThrow('gave up');
});

test('it throws when the work is still waiting after the clock time it is given', () => {
  const clock = createFakeClock();

  const work = (async () => {
    for (;;) {
      await clock.sleep(1000);
    }
  })();

  expect(awaitWithClock(clock, work, 5000)).rejects.toThrow(
    'the condition stayed false for 5000 ms of clock time',
  );
});

test('it waits in real time for work that awaits real I/O before it schedules anything', async () => {
  const clock = createFakeClock();

  const work = (async () => {
    await Bun.spawn([process.execPath, '-e', 'process.exit(0)']).exited;
    await clock.sleep(1000);

    return 'done';
  })();

  const result = await awaitWithClock(clock, work);

  expect(result).toBe('done');
});
