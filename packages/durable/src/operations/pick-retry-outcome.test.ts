import { expect, test } from 'bun:test';
import { pickRetryOutcome } from './pick-retry-outcome';

test.each([
  { label: 'an open operation', endedAt: null },
  { label: 'an operation that ended 1 ms short of 24 hours ago', endedAt: 1_799_913_600_001 },
])('it picks existing for the same kind and params on $label', (row) => {
  const outcome = pickRetryOutcome(
    { kind: 'shelf.build', params: '{"width":2}', endedAt: row.endedAt },
    { kind: 'shelf.build', params: '{"width":2}', now: 1_800_000_000_000 },
  );

  expect(outcome).toBe('existing');
});

test.each([
  { label: 'other params', kind: 'shelf.build', params: '{"width":3}' },
  { label: 'another kind', kind: 'shelf.paint', params: '{"width":2}' },
])('it picks conflict for $label under a kept key', (row) => {
  const outcome = pickRetryOutcome(
    { kind: 'shelf.build', params: '{"width":2}', endedAt: null },
    { kind: row.kind, params: row.params, now: 1_800_000_000_000 },
  );

  expect(outcome).toBe('conflict');
});

test('it picks expired for a key whose operation ended 24 hours ago', () => {
  const outcome = pickRetryOutcome(
    { kind: 'shelf.build', params: '{"width":2}', endedAt: 1_799_913_600_000 },
    { kind: 'shelf.build', params: '{"width":3}', now: 1_800_000_000_000 },
  );

  expect(outcome).toBe('expired');
});
