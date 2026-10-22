import { expect, test } from 'bun:test';
import { isValidSignature } from './is-valid-signature';

interface IsValidSignatureRow {
  readonly kind: string;
  readonly key: string;
  readonly text: string;
  readonly signature: string;
  readonly encoding: 'hex' | 'base64url';
  readonly expected: boolean;
}

// The signatures are the HMAC-SHA256 of test case 2 of RFC 4231.
test.each<IsValidSignatureRow>([
  {
    kind: 'the hex signature',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    encoding: 'hex',
    expected: true,
  },
  {
    kind: 'the base64url signature',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: 'W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM',
    encoding: 'base64url',
    expected: true,
  },
  {
    kind: 'the signature under another key',
    key: 'Jeff',
    text: 'what do ya want for nothing?',
    signature: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    encoding: 'hex',
    expected: false,
  },
  {
    kind: 'the signature of other text',
    key: 'Jefe',
    text: 'what do ya want for nothing?!',
    signature: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    encoding: 'hex',
    expected: false,
  },
  {
    kind: 'the hex signature in upper case',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: '5BDCC146BF60754E6A042426089575C75A003F089D2739839DEC58B964EC3843',
    encoding: 'hex',
    expected: false,
  },
  {
    kind: 'the hex signature with characters after it',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843zz',
    encoding: 'hex',
    expected: false,
  },
  {
    kind: 'a cut signature',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: '5bdcc146bf60754e',
    encoding: 'hex',
    expected: false,
  },
  {
    kind: 'an empty signature',
    key: 'Jefe',
    text: 'what do ya want for nothing?',
    signature: '',
    encoding: 'hex',
    expected: false,
  },
])('it checks $kind', (row) => {
  expect(isValidSignature(row.key, row.text, row.signature, row.encoding)).toBe(row.expected);
});
