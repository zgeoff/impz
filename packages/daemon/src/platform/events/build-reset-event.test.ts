import { expect, test } from 'bun:test';
import { buildResetEvent } from './build-reset-event';

test('it builds a reset at the seq and log it names', () => {
  const event = buildResetEvent({ seq: 9120, logId: 'log-a', at: 1_800_000_000_000 });

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    seq: 9120,
    logId: 'log-a',
    ev: 'Reset',
  });
});
