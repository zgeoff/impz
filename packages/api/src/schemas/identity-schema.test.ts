import { expect, test } from 'bun:test';
import { IdentityIssuerSchema, IdentityTrustDocumentSchema } from './identity-schema';

function setupTest() {
  return {
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
      kid: 'NmV4YW1wbGUta2V5LXRodW1icHJpbnQ',
      alg: 'ES256',
      use: 'sig',
    },
  };
}

test.each(['imp-host-a', 'host_1.example', 'A', 'a'.repeat(128)])(
  '#IdentityIssuerSchema accepts %s',
  (issuer) => {
    expect(IdentityIssuerSchema.safeParse(issuer).success).toBeTrue();
  },
);

test.each(['', 'a'.repeat(129), 'host a', 'host/a', 'höst', 'host:a'])(
  '#IdentityIssuerSchema rejects %p',
  (issuer) => {
    expect(IdentityIssuerSchema.safeParse(issuer).success).toBeFalse();
  },
);

test('#IdentityTrustDocumentSchema keeps a document with a retire entry', () => {
  const ctx = setupTest();

  const document = {
    issuer: 'imp-host-a',
    keys: [ctx.key, { ...ctx.key, kid: 'other' }],
    retire: [{ kid: ctx.key.kid, at: 1_794_355_200 }],
  };

  const parsed: unknown = IdentityTrustDocumentSchema.parse(document);

  expect(parsed).toStrictEqual(document);
});

test('#IdentityTrustDocumentSchema drops a private member of a key', () => {
  const ctx = setupTest();
  const withPrivate = Object.fromEntries([...Object.entries(ctx.key), ['d', 'private']]);

  const parsed = IdentityTrustDocumentSchema.parse({
    issuer: 'imp-host-a',
    keys: [withPrivate],
    retire: [],
  });

  const kept: unknown = parsed.keys[0];

  expect(kept).toStrictEqual(ctx.key);
});

test('#IdentityTrustDocumentSchema rejects a document with no key', () => {
  expect(
    IdentityTrustDocumentSchema.safeParse({ issuer: 'imp-host-a', keys: [], retire: [] }).success,
  ).toBeFalse();
});
