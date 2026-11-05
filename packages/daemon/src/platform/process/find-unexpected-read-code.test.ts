import { expect, test } from 'bun:test';
import { findUnexpectedReadCode } from './find-unexpected-read-code';

test.each([
  { code: 'ENOENT', expected: null },
  { code: 'EOPNOTSUPP', expected: null },
  { code: 'EACCES', expected: 'EACCES' },
  { code: 'EISDIR', expected: 'EISDIR' },
  { code: 'EMFILE', expected: 'EMFILE' },
])('it gives $expected for a read that fails with $code', (row) => {
  const error = Object.assign(new Error('read failed'), { code: row.code });

  expect(findUnexpectedReadCode(error)).toBe(row.expected);
});

test('it gives unknown for an error with no code', () => {
  expect(findUnexpectedReadCode(new Error('read failed'))).toBe('unknown');
});

test('it gives unknown for a thrown value that is not an error', () => {
  expect(findUnexpectedReadCode('read failed')).toBe('unknown');
});
