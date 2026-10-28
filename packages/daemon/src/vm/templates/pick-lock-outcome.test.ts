import { expect, test } from 'bun:test';
import { pickLockOutcome } from './pick-lock-outcome';

test('it reports a lock that failed with its errno', () => {
  expect(pickLockOutcome({ errno: 12 }, true)).toStrictEqual({ kind: 'failed', errno: 12 });
});

test('it reports a declined lock with its size in whole MiB', () => {
  expect(pickLockOutcome({ declinedBytes: 1_500_000 }, true)).toStrictEqual({
    kind: 'declined',
    lockMib: 2,
  });
});

test('it holds a lock of the current build, with its size in whole MiB', () => {
  const lock = { lockedBytes: 3 * 1024 * 1024, release: () => {} };

  expect(pickLockOutcome({ lock }, true)).toStrictEqual({ kind: 'held', lock, lockMib: 3 });
});

test('it marks a lock of a build that is no longer current as stale', () => {
  const lock = { lockedBytes: 4096, release: () => {} };

  expect(pickLockOutcome({ lock }, false)).toStrictEqual({ kind: 'stale', lock });
});
