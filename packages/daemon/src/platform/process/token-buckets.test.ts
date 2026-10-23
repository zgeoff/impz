import { expect, test } from 'bun:test';
import { createTokenBuckets } from './token-buckets';

test('it takes a token up to the bucket size, then refuses', () => {
  const tryTake = createTokenBuckets(
    () => ({ size: 2, refillMs: 1000 }),
    () => 0,
  );

  expect([tryTake('box'), tryTake('box'), tryTake('box')]).toStrictEqual([true, true, false]);
});

test('it refills one token each refill period', () => {
  const clock = { now: 0 };

  const tryTake = createTokenBuckets(
    () => ({ size: 1, refillMs: 1000 }),
    () => clock.now,
  );

  tryTake('box');

  clock.now = 999;

  const early = tryTake('box');

  clock.now = 1999;

  expect([early, tryTake('box')]).toStrictEqual([false, true]);
});

test('it refills no more than the bucket size', () => {
  const clock = { now: 0 };

  const tryTake = createTokenBuckets(
    () => ({ size: 1, refillMs: 10 }),
    () => clock.now,
  );

  tryTake('box');

  clock.now = 60_000;

  expect([tryTake('box'), tryTake('box')]).toStrictEqual([true, false]);
});

test("it keeps each key's bucket its own", () => {
  const tryTake = createTokenBuckets(
    () => ({ size: 1, refillMs: Infinity }),
    () => 0,
  );

  tryTake('box');

  expect(tryTake('web')).toBeTrue();
});

test("it reads each key's own bucket size", () => {
  const tryTake = createTokenBuckets(
    (slot: number) => ({ size: slot, refillMs: Infinity }),
    () => 0,
  );

  expect([tryTake(1), tryTake(1), tryTake(2), tryTake(2)]).toStrictEqual([true, false, true, true]);
});
