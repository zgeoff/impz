import { expect, test } from 'bun:test';
import { buildCursorEvent } from './build-cursor-event';

test.each(['Reset', 'Position'] as const)('it builds a %s at the seq and log it names', (ev) => {
  const event = buildCursorEvent(ev, { seq: 9120, logId: 'log-a', at: 1_800_000_000_000 });

  expect(event).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the event format's version field
    v: 1,
    at: new Date(1_800_000_000_000),
    seq: 9120,
    logId: 'log-a',
    ev,
  });
});
