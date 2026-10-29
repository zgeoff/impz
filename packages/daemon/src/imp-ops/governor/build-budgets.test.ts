import { expect, test } from 'bun:test';
import { buildBudgets } from './build-budgets';

test('it keeps the budget less the whole pool for guests on 4 KiB pages', () => {
  expect(buildBudgets(4000, { totalMib: 3000, freeMib: 1000 })).toStrictEqual({
    ramMib: 4000,
    ordinaryMib: 1000,
  });
});

test('it keeps no budget outside the pool on a host with no pool', () => {
  expect(buildBudgets(4000, null)).toStrictEqual({ ramMib: 4000, ordinaryMib: null });
});

test('it keeps no budget outside the pool on a host whose pool has no pages', () => {
  expect(buildBudgets(4000, { totalMib: 0, freeMib: 0 })).toStrictEqual({
    ramMib: 4000,
    ordinaryMib: null,
  });
});

test('it leaves nothing outside the pool when the pool is larger than the budget', () => {
  expect(buildBudgets(4000, { totalMib: 5000, freeMib: 5000 })).toStrictEqual({
    ramMib: 4000,
    ordinaryMib: 0,
  });
});
