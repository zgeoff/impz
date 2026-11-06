import { expect, test } from 'bun:test';
import { buildSetupNetGates } from './build-setup-net-gates';

test.each([
  ['every match', { tables: true, rpfilter: true, hl: true }, { fullRun: true, refusals: true }],
  [
    'the tables but no rpfilter match',
    { tables: true, rpfilter: false, hl: true },
    { fullRun: false, refusals: true },
  ],
  [
    'the tables but no hl match',
    { tables: true, rpfilter: true, hl: false },
    { fullRun: false, refusals: true },
  ],
  [
    'the tables but neither match, as a cloud imp',
    { tables: true, rpfilter: false, hl: false },
    { fullRun: false, refusals: true },
  ],
  ['no tables', { tables: false, rpfilter: true, hl: true }, { fullRun: false, refusals: false }],
])('it gates the setup-net tests for a host with %s', (_, netfilter, expected) => {
  expect(buildSetupNetGates(netfilter)).toStrictEqual(expected);
});
