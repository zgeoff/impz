import { expect, test } from 'bun:test';
import { pickRetryOutcome } from './pick-retry-outcome';

test.each([
  { label: 'an open operation', endedAt: null },
  { label: 'an operation that ended 1 ms short of 24 hours ago', endedAt: 1_799_913_600_001 },
])('it picks existing for the same request on $label', (row) => {
  const outcome = pickRetryOutcome(
    {
      kind: 'shelf.build',
      params: '{"width":2}',
      targetId: 'shelf-1',
      principal: 'owner',
      endedAt: row.endedAt,
    },
    {
      kind: 'shelf.build',
      params: '{"width":2}',
      targetId: 'shelf-1',
      principal: 'owner',
      now: 1_800_000_000_000,
    },
  );

  expect(outcome).toBe('existing');
});

test.each([
  {
    label: 'other params',
    kind: 'shelf.build',
    params: '{"width":3}',
    targetId: 'shelf-1',
    principal: 'owner',
  },
  {
    label: 'another kind',
    kind: 'shelf.paint',
    params: '{"width":2}',
    targetId: 'shelf-1',
    principal: 'owner',
  },
  {
    label: 'another target',
    kind: 'shelf.build',
    params: '{"width":2}',
    targetId: 'shelf-2',
    principal: 'owner',
  },
  {
    label: 'no target',
    kind: 'shelf.build',
    params: '{"width":2}',
    targetId: null,
    principal: 'owner',
  },
  {
    label: 'another principal',
    kind: 'shelf.build',
    params: '{"width":2}',
    targetId: 'shelf-1',
    principal: 'guest',
  },
])('it picks conflict for $label under a kept key', (row) => {
  const outcome = pickRetryOutcome(
    {
      kind: 'shelf.build',
      params: '{"width":2}',
      targetId: 'shelf-1',
      principal: 'owner',
      endedAt: null,
    },
    {
      kind: row.kind,
      params: row.params,
      targetId: row.targetId,
      principal: row.principal,
      now: 1_800_000_000_000,
    },
  );

  expect(outcome).toBe('conflict');
});

test('it picks expired for a key whose operation ended 24 hours ago', () => {
  const outcome = pickRetryOutcome(
    {
      kind: 'shelf.build',
      params: '{"width":2}',
      targetId: 'shelf-1',
      principal: 'owner',
      endedAt: 1_799_913_600_000,
    },
    {
      kind: 'shelf.build',
      params: '{"width":3}',
      targetId: 'shelf-2',
      principal: 'guest',
      now: 1_800_000_000_000,
    },
  );

  expect(outcome).toBe('expired');
});
