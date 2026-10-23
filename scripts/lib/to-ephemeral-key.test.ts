import { expect, test } from 'bun:test';
import { toEphemeralKey } from './to-ephemeral-key.ts';

test.each([
  ['tskey-client-fake', 'tskey-client-fake?ephemeral=true&preauthorized=true'],
  ['tskey-client-fake?ephemeral=false', 'tskey-client-fake?ephemeral=true&preauthorized=true'],
])('it makes %p an ephemeral, preauthorized key', (secret, key) => {
  expect(toEphemeralKey(secret)).toBe(key);
});
