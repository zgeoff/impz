import { expect, test } from 'bun:test';
import { isSameDigest } from './is-same-digest';

test.each([
  ['equal bytes', [1, 2, 3], [1, 2, 3], true],
  ['bytes that differ in the last place', [1, 2, 3], [1, 2, 4], false],
  ['a shorter digest', [1, 2, 3], [1, 2], false],
  ['a longer digest', [1, 2], [1, 2, 3], false],
  ['two empty digests', [], [], true],
])('it compares %s', (_kind, left, right, expected) => {
  expect(isSameDigest(Uint8Array.from(left), Uint8Array.from(right))).toBe(expected);
});
