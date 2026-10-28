import { expect, test } from 'bun:test';
import { canAdmitLock } from './can-admit-lock';

test.each([
  ['nothing held and a lock of a tenth of the budget', 0, 10 * 1024 * 1024, true],
  ['nothing held and a lock one byte past a tenth', 0, 10 * 1024 * 1024 + 1, false],
  ['4 MiB held and a 6 MiB lock', 4 * 1024 * 1024, 6 * 1024 * 1024, true],
  ['6 MiB held and a 6 MiB lock', 6 * 1024 * 1024, 6 * 1024 * 1024, false],
])('it admits on a 100 MiB budget with %s: %p', (_label, heldBytes, lockBytes, expected) => {
  expect(canAdmitLock({ heldBytes, lockBytes, ramBudgetMib: 100 })).toBe(expected);
});

test('it admits no lock on a budget too small for a tenth to hold a whole MiB', () => {
  expect(canAdmitLock({ heldBytes: 0, lockBytes: 4096, ramBudgetMib: 9 })).toBe(false);
});
