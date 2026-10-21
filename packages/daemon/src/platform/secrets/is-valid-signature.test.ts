import { expect, test } from 'bun:test';
import { isValidSignature } from './is-valid-signature';

// The signatures are the HMAC-SHA256 of test case 2 of RFC 4231.
test.each([
  [
    'the hex signature',
    'Jefe',
    'what do ya want for nothing?',
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'hex',
    true,
  ],
  [
    'the base64url signature',
    'Jefe',
    'what do ya want for nothing?',
    'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM',
    'base64url',
    true,
  ],
  [
    'the signature under another key',
    'Jeff',
    'what do ya want for nothing?',
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'hex',
    false,
  ],
  [
    'the signature of other text',
    'Jefe',
    'what do ya want for nothing?!',
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    'hex',
    false,
  ],
  [
    'the hex signature in upper case',
    'Jefe',
    'what do ya want for nothing?',
    '5BDCC146BF60754E6A042426089575C75A003F089D2739839DEC58B964EC3843',
    'hex',
    false,
  ],
  [
    'the hex signature with characters after it',
    'Jefe',
    'what do ya want for nothing?',
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843zz',
    'hex',
    false,
  ],
  ['a cut signature', 'Jefe', 'what do ya want for nothing?', '5bdcc146bf60754e', 'hex', false],
  ['an empty signature', 'Jefe', 'what do ya want for nothing?', '', 'hex', false],
] as const)('it checks %s', (_kind, key, text, signature, encoding, expected) => {
  expect(isValidSignature(key, text, signature, encoding)).toBe(expected);
});
