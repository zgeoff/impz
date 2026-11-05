import { expect, test } from 'bun:test';
import { findUnexpectedReadCode } from './find-unexpected-read-code';

test.each([{ code: 'ENOENT' }, { code: 'EOPNOTSUPP' }])(
  'it gives null for a read that fails with $code, which a kernel without the counter gives',
  (row) => {
    const error = Object.assign(new Error('read failed'), { code: row.code });

    expect(findUnexpectedReadCode(error)).toBeNull();
  },
);

test.each([{ code: 'EACCES' }, { code: 'EISDIR' }, { code: 'EMFILE' }])(
  'it gives the code of a read that fails with $code',
  (row) => {
    const error = Object.assign(new Error('read failed'), { code: row.code });

    expect(findUnexpectedReadCode(error)).toBe(row.code);
  },
);

test('it gives unknown for an error with no code', () => {
  expect(findUnexpectedReadCode(new Error('read failed'))).toBe('unknown');
});

test('it gives unknown for a thrown value that is not an error', () => {
  expect(findUnexpectedReadCode('read failed')).toBe('unknown');
});
