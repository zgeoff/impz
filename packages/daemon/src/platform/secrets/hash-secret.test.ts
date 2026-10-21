import { expect, test } from 'bun:test';
import { hashSecret } from './hash-secret';

test('it hashes a secret to its SHA-256 digest', () => {
  // SHA-256 of "abc", from FIPS 180-2's examples
  expect(hashSecret('abc').toString('hex')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
