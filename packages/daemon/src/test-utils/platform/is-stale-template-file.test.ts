import { expect, test } from 'bun:test';
import { isStaleTemplateFile } from './is-stale-template-file';

test.each([
  [
    'a build whose owner is gone',
    'pid7-ns9-3f2a-003_add_broker-fedcba9876543210.sqlite',
    1000,
    true,
  ],
  [
    'a build older than an hour',
    'pid7-ns9-3f2a-003_add_broker-fedcba9876543210.sqlite',
    3_600_001,
    false,
  ],
  [
    'a template of older migrations built over an hour ago',
    '003_add_broker-fedcba9876543210.sqlite',
    3_600_001,
    false,
  ],
])('it marks %s stale', (_, name, ageMs, isOwnerGone) => {
  expect(isStaleTemplateFile({ name, ageMs, isOwnerGone }, '0123456789abcdef')).toBeTrue();
});

test.each([
  ['a build of a running owner', 'pid7-ns9-3f2a-003_add_broker-fedcba9876543210.sqlite', 60_000],
  ['a template of the current migrations', '003_add_broker-0123456789abcdef.sqlite', 7_200_000],
  [
    'a template of older migrations built within the hour',
    '003_add_broker-fedcba9876543210.sqlite',
    60_000,
  ],
])('it keeps %s', (_, name, ageMs) => {
  expect(isStaleTemplateFile({ name, ageMs, isOwnerGone: false }, '0123456789abcdef')).toBeFalse();
});
