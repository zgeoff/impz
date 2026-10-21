import { expect, test } from 'bun:test';
import { sign } from './sign';

test('it signs text with HMAC-SHA256', () => {
  // test case 2 of RFC 4231
  expect(sign('Jefe', 'what do ya want for nothing?').toString('hex')).toBe(
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
  );
});

test('it signs with a key given as bytes as with the same key given as text', () => {
  expect(sign(Buffer.from('Jefe'), 'what do ya want for nothing?')).toStrictEqual(
    sign('Jefe', 'what do ya want for nothing?'),
  );
});
