import { expect, test } from 'bun:test';
import { buildStubIdentityKey, buildStubIdentityToken } from './build-stub-identity-token';

test('it builds a token of three base64url parts whose header names the key', () => {
  const key = buildStubIdentityKey('k1');
  const token = buildStubIdentityToken({ key, claims: { sub: 'a' } });
  const [header = '', claims = '', signature = ''] = token.split('.');

  expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toStrictEqual({
    alg: 'ES256',
    typ: 'JWT',
    kid: 'k1',
  });

  expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toStrictEqual({ sub: 'a' });
  expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
});

test('it takes the algorithm named in the header from the caller', () => {
  const key = buildStubIdentityKey('k1');
  const token = buildStubIdentityToken({ key, claims: {}, alg: 'HS256' });

  const header: unknown = JSON.parse(
    Buffer.from(token.split('.')[0] ?? '', 'base64url').toString(),
  );

  expect(header).toStrictEqual({
    alg: 'HS256',
    typ: 'JWT',
    kid: 'k1',
  });
});
