import { expect, test } from 'bun:test';
import { collectImpEvents } from './collect-imp-events.ts';

test('it collects the events of the named imp in order, and skips other imps and other lines', () => {
  const lines = [
    '{"ev":"ImpAdded","reason":"snapshot","imp":{"name":"wv-other","state":"running"}}',
    'impz: the event stream ended (closed); reconnecting in 1000ms',
    '{"ev":"ImpAdded","reason":"created","imp":{"name":"wv-a","state":"creating"}}',
    '{"ev":"GovernorDecision","decision":"admitted","name":"wv-a"}',
    '{"ev":"ImpRemoved","imp":{"name":"wv-a","state":"sleeping"}}',
  ];

  expect(collectImpEvents(lines, 'wv-a')).toStrictEqual([
    { ev: 'ImpAdded', reason: 'created', state: 'creating' },
    { ev: 'ImpRemoved', reason: null, state: 'sleeping' },
  ]);
});
