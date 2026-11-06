import { expect, test } from 'bun:test';
import { pickPrunePlan } from './pick-prune-plan';

test('it picks no prune when no event is too old or past the row limit', () => {
  const plan = pickPrunePlan({
    now: 1_800_000_000_000,
    oldestKeptSeq: null,
    lastAgedSeq: null,
    lastCountedSeq: null,
  });

  expect(plan).toStrictEqual({ kind: 'none' });
});

test.each([
  {
    label: 'only old events',
    oldestKeptSeq: null,
    lastAgedSeq: 7,
    lastCountedSeq: null,
    belowSeq: 0,
    mark: 7,
  },
  {
    label: 'only events past the row limit',
    oldestKeptSeq: 9,
    lastAgedSeq: null,
    lastCountedSeq: 8,
    belowSeq: 9,
    mark: 8,
  },
  {
    label: 'old events above the row limit',
    oldestKeptSeq: 9,
    lastAgedSeq: 12,
    lastCountedSeq: 8,
    belowSeq: 9,
    mark: 12,
  },
])('it marks $mark as pruned for $label', (row) => {
  const plan = pickPrunePlan({
    now: 1_800_000_000_000,
    oldestKeptSeq: row.oldestKeptSeq,
    lastAgedSeq: row.lastAgedSeq,
    lastCountedSeq: row.lastCountedSeq,
  });

  expect(plan).toStrictEqual({
    kind: 'prune',
    beforeAt: 1_799_395_200_000,
    belowSeq: row.belowSeq,
    prunedThrough: row.mark,
  });
});
