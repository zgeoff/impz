import { expect, test } from 'bun:test';
import { buildMockGovernorDecision } from '@impz/api/test-utils/build-mock-governor-decision';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { pickNextCursor } from './pick-next-cursor';

test('it moves the cursor to a logged event', () => {
  const event = buildMockGovernorDecision({ seq: 41, logId: 'log-a' });

  expect(pickNextCursor({ after: 40, logId: 'log-a' }, event)).toStrictEqual({
    after: 41,
    logId: 'log-a',
  });
});

test('it keeps the cursor through a snapshot event', () => {
  const cursor = pickNextCursor(
    {},
    {
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      v: 1,
      at: new Date(1_800_000_000_000),
      seq: 90,
      logId: 'log-a',
      ev: 'ImpAdded',
      reason: 'snapshot',
      imp: buildMockImp({ name: 'tidy-heron' }),
    },
  );

  expect(cursor).toStrictEqual({});
});

test('it clears the cursor at a reset', () => {
  const cursor = pickNextCursor(
    { after: 40, logId: 'log-a' },
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    { v: 1, at: new Date(1_800_000_000_000), seq: 90, logId: 'log-b', ev: 'Reset' },
  );

  expect(cursor).toStrictEqual({});
});
