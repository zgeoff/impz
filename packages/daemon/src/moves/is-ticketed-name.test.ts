import { expect, test } from 'bun:test';
import { isTicketedName } from './is-ticketed-name';

test.each([
  ['the exact name', 'dev', true],
  ['a different name', 'other', false],
  ['a case variant', 'Dev', false],
  ['an empty name', '', false],
  ['the name with whitespace', 'dev ', false],
  ['a unicode look-alike', 'dеv', false],
  ['the name in another normal form', 'café', false],
])('#isTicketedName judges %s (%p) against a ticket for dev', (_kind, headerName, expected) => {
  const isTicketed = isTicketedName('dev', headerName);

  expect(isTicketed).toBe(expected);
});
