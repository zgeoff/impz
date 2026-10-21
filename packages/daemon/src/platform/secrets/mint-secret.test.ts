import { expect, test } from 'bun:test';
import { mintSecret } from './mint-secret';

test('it mints 32 random bytes as base64url', () => {
  expect(mintSecret()).toMatch(/^[\w\-]{43}$/v);
});

test('it mints a different secret each time', () => {
  expect(mintSecret()).not.toBe(mintSecret());
});
