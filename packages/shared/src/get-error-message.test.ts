import { expect, test } from 'bun:test';
import { getErrorMessage } from './get-error-message';

test.each([
  { label: 'an Error', error: new Error('the disk is full'), message: 'the disk is full' },
  { label: 'a string', error: 'the disk is full', message: 'the disk is full' },
  { label: 'a number', error: 28, message: '28' },
  { label: 'null', error: null, message: 'null' },
])('it returns the message of $label', (row) => {
  expect(getErrorMessage(row.error)).toBe(row.message);
});
