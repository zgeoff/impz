import { expect, test } from 'bun:test';
import type { IdentityTrustDocument } from '@impz/api';
import {
  buildStubIdentityKey,
  buildStubIdentityToken,
} from '../test-utils/build-stub-identity-token';
import type { StubIdentityKey } from '../test-utils/build-stub-identity-token';
import { verifyImpIdentity } from './verify-imp-identity';

function setupTest() {
  const keyA = buildStubIdentityKey('key-a');
  const keyB = buildStubIdentityKey('key-b');
  const documentA: IdentityTrustDocument = { issuer: 'host-a', keys: [keyA.jwk], retire: [] };
  const documentB: IdentityTrustDocument = { issuer: 'host-b', keys: [keyB.jwk], retire: [] };

  const buildToken = (
    claims: Readonly<Record<string, unknown>> = {},
    key: StubIdentityKey = keyA,
  ): string =>
    buildStubIdentityToken({
      key,
      claims: {
        iss: 'host-a',
        sub: '0192f3a1-7b2c-7d4e-8f10-3a5b6c7d8e9f',
        aud: 'tasks.imp.internal',
        iat: 1000,
        exp: 1055,
        jti: 'b3f1c2d4e5a60718293a4b5c6d7e8f90',
        imp_name: 'dev-7f3a',
        ...claims,
      },
    });

  const verify = (
    header: string | null,
    nowSeconds: number,
    issuers: readonly IdentityTrustDocument[] = [documentA],
  ) => verifyImpIdentity(header, { issuers, audience: 'tasks.imp.internal', nowSeconds });

  return { keyA, keyB, documentA, documentB, buildToken, verify };
}

test('it accepts a token and names the imp by issuer, id and name', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken(), 1010)).resolves.toStrictEqual({
    issuer: 'host-a',
    id: '0192f3a1-7b2c-7d4e-8f10-3a5b6c7d8e9f',
    name: 'dev-7f3a',
  });
});

test('it refuses a valid token whose issuer names no configured document', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken({ iss: 'host-z' }), 1010)).resolves.toBeNull();
});

test('it refuses a token that host B signed with host A’s issuer, when it holds both documents', () => {
  const ctx = setupTest();
  const token = ctx.buildToken({ iss: 'host-a' }, ctx.keyB);

  expect(ctx.verify(token, 1010, [ctx.documentA, ctx.documentB])).resolves.toBeNull();
});

test('it accepts a token of host B when it holds both documents', () => {
  const ctx = setupTest();
  const token = ctx.buildToken({ iss: 'host-b' }, ctx.keyB);

  expect(ctx.verify(token, 1010, [ctx.documentA, ctx.documentB])).resolves.toMatchObject({
    issuer: 'host-b',
  });
});

test.each([
  [1060, true],
  [1061, false],
])(
  'it decides a token with iat 1000 and exp 1055 at %d: accepted is %p',
  async (now, isAccepted) => {
    const ctx = setupTest();

    const result = await ctx.verify(ctx.buildToken(), now);

    expect(result !== null).toBe(isAccepted);
  },
);

test.each([1001, 1030, 1060, 1061])('it refuses a token with exp at iat plus 60 at %d', (now) => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken({ exp: 1060 }), now)).resolves.toBeNull();
});

test.each([
  [1000, false],
  [1001, true],
])('it decides a token with iat 1006 at %d: accepted is %p', async (now, isAccepted) => {
  const ctx = setupTest();

  const result = await ctx.verify(ctx.buildToken({ iat: 1006, exp: 1060 }), now);

  expect(result !== null).toBe(isAccepted);
});

test('it refuses a token for another audience', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken({ aud: 'other.imp.internal' }), 1010)).resolves.toBeNull();
});

test('it refuses a token with an empty sub', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken({ sub: '' }), 1010)).resolves.toBeNull();
});

test('it refuses a token whose signature another key made', () => {
  const ctx = setupTest();
  const forger = buildStubIdentityKey('key-a');

  expect(ctx.verify(ctx.buildToken({}, forger), 1010)).resolves.toBeNull();
});

test('it refuses a token with another algorithm', () => {
  const ctx = setupTest();

  const token = buildStubIdentityToken({
    key: ctx.keyA,
    alg: 'none',
    claims: {
      iss: 'host-a',
      sub: 'x',
      aud: 'tasks.imp.internal',
      iat: 1000,
      exp: 1055,
      imp_name: 'n',
    },
  });

  expect(ctx.verify(token, 1010)).resolves.toBeNull();
});

test.each([[null], [''], ['not a token'], ['a.b'], ['a.b.c.d']])(
  'it refuses the header %p',
  (header) => {
    const ctx = setupTest();

    expect(ctx.verify(header, 1010)).resolves.toBeNull();
  },
);

test('it refuses a header that repeats the token', () => {
  const ctx = setupTest();
  const token = ctx.buildToken();

  expect(ctx.verify(`${token}, ${token}`, 1010)).resolves.toBeNull();
});

test.each([
  [2054, true],
  [2055, false],
])(
  'it decides a retired key’s token with iat 1999 and exp 2054 at %d: accepted is %p',
  async (now, isAccepted) => {
    const ctx = setupTest();

    const document: IdentityTrustDocument = {
      issuer: 'host-a',
      keys: [ctx.keyA.jwk, ctx.keyB.jwk],
      retire: [{ kid: 'key-a', at: 2000 }],
    };

    const result = await ctx.verify(ctx.buildToken({ iat: 1999, exp: 2054 }), now, [document]);

    expect(result !== null).toBe(isAccepted);
  },
);

test('it refuses a retired key’s token with iat at the switch time', () => {
  const ctx = setupTest();

  const document: IdentityTrustDocument = {
    issuer: 'host-a',
    keys: [ctx.keyA.jwk, ctx.keyB.jwk],
    retire: [{ kid: 'key-a', at: 2000 }],
  };

  const token = ctx.buildToken({ iat: 2000, exp: 2055 });

  expect(ctx.verify(token, 2000, [document])).resolves.toBeNull();
});

test('it accepts a new key’s token in a document that retires the old key', () => {
  const ctx = setupTest();

  const document: IdentityTrustDocument = {
    issuer: 'host-a',
    keys: [ctx.keyA.jwk, ctx.keyB.jwk],
    retire: [{ kid: 'key-a', at: 2000 }],
  };

  const token = ctx.buildToken({ iat: 2000, exp: 2055 }, ctx.keyB);

  expect(ctx.verify(token, 2056, [document])).resolves.toMatchObject({ issuer: 'host-a' });
});

test('it refuses a token of a key the document does not hold yet', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken({}, ctx.keyB), 1010)).resolves.toBeNull();
});

test('it rejects two documents with one issuer', () => {
  const ctx = setupTest();
  const token = ctx.buildToken();

  expect(ctx.verify(token, 1010, [ctx.documentA, ctx.documentA])).rejects.toThrow(
    'two identity key documents name the issuer host-a',
  );
});

test('it rejects an empty list of documents', () => {
  const ctx = setupTest();

  expect(ctx.verify(ctx.buildToken(), 1010, [])).rejects.toThrow(
    'no identity key document is configured',
  );
});
