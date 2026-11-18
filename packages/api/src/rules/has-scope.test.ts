import { expect, test } from 'bun:test';
import { hasScope } from './has-scope';

test.each([
  ['read', 'read', true],
  ['read', 'exec', false],
  ['read', 'manage', false],
  ['exec', 'read', true],
  ['exec', 'exec', true],
  ['exec', 'manage', false],
  ['manage', 'read', true],
  ['manage', 'exec', true],
  ['manage', 'manage', true],
] as const)('it answers %s holding %s with %p', (granted, needed, held) => {
  expect(hasScope(granted, needed)).toBe(held);
});

test('it refuses a needed scope outside the list, even to manage', () => {
  expect(hasScope('manage', 'admin')).toBeFalse();
});

test('it holds nothing for a granted scope outside the list', () => {
  expect(hasScope('admin', 'read')).toBeFalse();
});
