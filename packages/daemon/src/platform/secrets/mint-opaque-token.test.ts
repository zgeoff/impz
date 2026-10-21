import { expect, test } from 'bun:test';
import { mintOpaqueToken } from './mint-opaque-token';

test('it mints the prefix, a 12-byte id and a 32-byte secret, joined by a dot', () => {
  const minted = mintOpaqueToken('tok_');

  expect(minted).toStrictEqual({
    id: expect.stringMatching(/^[\w\-]{16}$/v),
    secret: expect.stringMatching(/^[\w\-]{43}$/v),
    text: `tok_${minted.id}.${minted.secret}`,
  });
});

test('it mints a different id and secret each time', () => {
  const first = mintOpaqueToken('');
  const second = mintOpaqueToken('');

  expect(first.id).not.toBe(second.id);
  expect(first.secret).not.toBe(second.secret);
});
