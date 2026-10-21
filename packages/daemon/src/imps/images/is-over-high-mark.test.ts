import { expect, test } from 'bun:test';
import { isOverHighMark } from './is-over-high-mark';

test.each([
  ['below the high mark', 79, 21, false],
  ['at the high mark', 80, 20, true],
  ['above the high mark', 95, 5, true],
])('it reads usage %s', (_label, usedBytes, availableBytes, expected) => {
  expect(isOverHighMark({ usedBytes, availableBytes }, { highPercent: 80, lowPercent: 60 })).toBe(
    expected,
  );
});
