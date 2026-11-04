import { expect, test } from 'bun:test';
import { isStaleTemplateFile } from './is-stale-template-file';

test.each([
  ['a lock whose owner is gone', '003_add_broker-0123456789abcdef.sqlite.lock', 1000, true],
  ['a lock older than 30 s', '003_add_broker-0123456789abcdef.sqlite.lock', 30_001, false],
  ['a build whose owner is gone', 'pid7-ns9-003_add_broker-fedcba9876543210.sqlite', 1000, true],
  [
    'a build older than an hour',
    'pid7-ns9-003_add_broker-fedcba9876543210.sqlite',
    3_600_001,
    false,
  ],
  [
    'a template of older migrations unused for an hour',
    '003_add_broker-fedcba9876543210.sqlite',
    3_600_001,
    false,
  ],
])('it marks %s stale', (_, name, ageMs, isOwnerGone) => {
  expect(isStaleTemplateFile({ name, ageMs, isOwnerGone }, '0123456789abcdef')).toBeTrue();
});

test.each([
  ['a lock of a running owner', '003_add_broker-0123456789abcdef.sqlite.lock', 1000],
  ['a build of a running owner', 'pid7-ns9-003_add_broker-fedcba9876543210.sqlite', 60_000],
  ['a template of the current migrations', '003_add_broker-0123456789abcdef.sqlite', 7_200_000],
  [
    'a template of older migrations used within the hour',
    '003_add_broker-fedcba9876543210.sqlite',
    60_000,
  ],
])('it keeps %s', (_, name, ageMs) => {
  expect(isStaleTemplateFile({ name, ageMs, isOwnerGone: false }, '0123456789abcdef')).toBeFalse();
});
