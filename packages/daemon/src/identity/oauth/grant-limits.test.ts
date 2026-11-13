import { expect, test } from 'bun:test';
import { formatScopeList, isPatternsWithin, pickGrantScope, pickLowerScope } from './grant-limits';

test.each([
  [['dev-1'], ['dev-*']],
  [['dev-a*'], ['dev-*']],
  [['dev-*'], ['dev-*']],
  [['web'], ['web', 'dev-*']],
  [['*'], ['*']],
  [['dev-1'], ['*']],
  [[], ['dev-*']],
  [null, null],
  [['anything'], null],
])('#isPatternsWithin keeps grant patterns %p within token patterns %p', (grant, token) => {
  expect(isPatternsWithin(grant, token)).toBeTrue();
});

test.each([
  [['dev*'], ['dev-*']],
  [['web'], ['dev-*']],
  [['dev-1', 'web'], ['dev-*']],
  [['*'], ['dev-*']],
  [null, ['*']],
  [['dev-1'], ['d*v-1']],
])('#isPatternsWithin refuses grant patterns %p past token patterns %p', (grant, token) => {
  expect(isPatternsWithin(grant, token)).toBeFalse();
});

test.each([
  ['manage', 'exec', 'exec'],
  ['exec', 'manage', 'exec'],
  ['read', 'manage', 'read'],
  ['exec', 'exec', 'exec'],
] as const)('#pickLowerScope picks the lower of %s and %s, %s', (first, second, lower) => {
  expect(pickLowerScope(first, second)).toBe(lower);
});

test.each([
  ['read', 'read'],
  ['exec', 'read exec'],
  ['manage', 'read exec manage'],
] as const)('#formatScopeList lists %s as %p', (scope, list) => {
  expect(formatScopeList(scope)).toBe(list);
});

test.each([
  [['read', 'exec', 'offline_access'], 'exec'],
  [['manage', 'read'], 'manage'],
  [['offline_access'], 'read'],
  [[], 'read'],
] as const)('#pickGrantScope picks the highest of %p as %s', (scopes, highest) => {
  expect(pickGrantScope(scopes)).toBe(highest);
});
