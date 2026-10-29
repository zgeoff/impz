import { expect, test } from 'bun:test';
import { pickShortfall } from './pick-shortfall';

test('it picks the whole budget on a host with no pool', () => {
  expect(
    pickShortfall({ ramMib: 900, ordinaryMib: 900 }, { ramMib: 1000, ordinaryMib: null }, 300),
  ).toStrictEqual({ budget: 'ram', budgetMib: 1000, usedMib: 900, missingMib: 200 });
});

test('it picks the budget outside the pool when the request misses it by more', () => {
  expect(
    pickShortfall({ ramMib: 2000, ordinaryMib: 800 }, { ramMib: 4000, ordinaryMib: 1000 }, 300),
  ).toStrictEqual({ budget: 'ordinary', budgetMib: 1000, usedMib: 800, missingMib: 100 });
});

test('it picks the whole budget when the request misses it by more than the budget outside the pool', () => {
  expect(
    pickShortfall({ ramMib: 3900, ordinaryMib: 100 }, { ramMib: 4000, ordinaryMib: 1000 }, 300),
  ).toStrictEqual({ budget: 'ram', budgetMib: 4000, usedMib: 3900, missingMib: 200 });
});
