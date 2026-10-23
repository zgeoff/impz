import { expect, test } from 'bun:test';
import { formatLocalTimestamp } from './format-local-timestamp.ts';

test('it formats the local time with every field two digits wide', () => {
  expect(formatLocalTimestamp(new Date(2026, 0, 2, 3, 4, 5))).toBe('2026-01-02 03:04:05');
});

test('it formats the last second of a year', () => {
  expect(formatLocalTimestamp(new Date(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31 23:59:59');
});
