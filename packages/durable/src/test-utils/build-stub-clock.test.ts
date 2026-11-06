import { expect, test } from 'bun:test';
import { buildStubClock } from './build-stub-clock';

test('it fires a timer once its delay has passed', () => {
  const clock = buildStubClock(1000);
  const fired: number[] = [];

  clock.startTimer(() => {
    fired.push(clock.now());
  }, 500);

  clock.runFor(500);

  expect(fired).toStrictEqual([1500]);
});

test('it leaves a timer whose delay has not passed', () => {
  const clock = buildStubClock(1000);
  const fired: string[] = [];

  clock.startTimer(() => {
    fired.push('late');
  }, 500);

  clock.runFor(499);

  expect(fired).toStrictEqual([]);
});

test('it never fires a cancelled timer', () => {
  const clock = buildStubClock(1000);
  const fired: string[] = [];

  const cancel = clock.startTimer(() => {
    fired.push('cancelled');
  }, 500);

  cancel();

  clock.runFor(1000);

  expect(fired).toStrictEqual([]);
});

test('it fires due timers in the order they fall due', () => {
  const clock = buildStubClock(0);
  const fired: string[] = [];

  clock.startTimer(() => {
    fired.push('second');
  }, 200);

  clock.startTimer(() => {
    fired.push('first');
  }, 100);

  clock.runFor(300);

  expect(fired).toStrictEqual(['first', 'second']);
});

test('it lists the delays of the timers still pending', () => {
  const clock = buildStubClock(0);

  clock.startTimer(() => {}, 100);
  clock.startTimer(() => {}, 4000);
  clock.runFor(100);

  expect(clock.readPendingMs()).toStrictEqual([4000]);
});
