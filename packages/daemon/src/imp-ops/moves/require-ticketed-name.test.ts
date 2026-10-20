import { expect, test } from 'bun:test';
import { MoveRequestError } from './move-request-error';
import { requireTicketedName } from './require-ticketed-name';

test('#requireTicketedName passes the exact name of the ticket’s imp', () => {
  expect(() => {
    requireTicketedName('dev', 'dev');
  }).not.toThrow();
});

test.each([
  ['a different name', 'other'],
  ['a case variant', 'Dev'],
  ['an empty name', ''],
  ['the name with whitespace', 'dev '],
  ['a unicode look-alike', 'dеv'],
])('#requireTicketedName refuses %s with a 403', (_kind, headerName) => {
  expect(() => {
    requireTicketedName('dev', headerName);
  }).toThrow(new MoveRequestError(403, `the ticket is for dev, not ${headerName}`));
});
