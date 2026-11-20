import { expect, test } from 'bun:test';
import { loadIdentityIssuers, verifyImpIdentity } from '@impz/client/identity';
import { IDENTITY_HEADER, createTestIdentityIssuer } from './create-test-identity-issuer';

async function setupTest() {
  const issuer = await createTestIdentityIssuer({ issuer: 'host-a' });

  const verify = (
    token: string,
    nowSeconds: number,
    options: { audience?: string; documents?: readonly unknown[] } = {},
  ) =>
    verifyImpIdentity(token, {
      issuers: loadIdentityIssuers(options.documents ?? [issuer.document]),
      audience: options.audience ?? 'tasks.imp.internal',
      nowSeconds,
    });

  return { issuer, verify };
}

test('it signs a token that verifyImpIdentity accepts and names the imp', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  await expect(ctx.verify(token, 1010)).resolves.toStrictEqual({
    issuer: 'host-a',
    id: 'imp-1',
    name: 'dev-7f3a',
  });
});

test('it signs the header, claims and raw signature that impd signs', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    nowSeconds: 2000,
  });

  const [header = '', claims = '', signature = ''] = token.split('.');
  const decodedHeader: unknown = JSON.parse(Buffer.from(header, 'base64url').toString());
  const decodedClaims: unknown = JSON.parse(Buffer.from(claims, 'base64url').toString());

  expect(decodedHeader).toStrictEqual({ alg: 'ES256', typ: 'JWT', kid: 'host-a-key-1' });

  expect(decodedClaims).toStrictEqual({
    iss: 'host-a',
    sub: 'imp-1',
    aud: 'tasks.imp.internal',
    iat: 2000,
    exp: 2055,
    jti: expect.stringMatching(/^[0-9a-f]{32}$/u),
    imp_name: 'dev-7f3a',
  });

  expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
});

test('it takes an exp the caller sets', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 100,
    exp: 130,
  });

  const claims: unknown = JSON.parse(
    Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
  );

  expect(claims).toMatchObject({ iat: 100, exp: 130 });
});

test('it gives each issuer its own kid unless the test passes one', async () => {
  const other = await createTestIdentityIssuer({ issuer: 'host-b' });
  const shared = await createTestIdentityIssuer({ issuer: 'host-c', kid: 'shared' });

  expect([other.kid, shared.kid]).toStrictEqual(['host-b-key-1', 'shared']);
});

test('it holds one public key and no retire entry in its document', async () => {
  const ctx = await setupTest();

  expect(ctx.issuer.document).toStrictEqual({
    issuer: 'host-a',
    keys: [
      {
        kty: 'EC',
        crv: 'P-256',
        x: expect.any(String),
        y: expect.any(String),
        kid: 'host-a-key-1',
        alg: 'ES256',
        use: 'sig',
      },
    ],
    retire: [],
  });
});

test('it names the header that carries the token', () => {
  expect(IDENTITY_HEADER).toBe('imp-identity');
});

test('it fails a token for another audience', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  await expect(ctx.verify(token, 1010, { audience: 'other.imp.internal' })).resolves.toBeNull();
});

test('it fails a token that a forged key signed', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.forge({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  await expect(ctx.verify(token, 1010)).resolves.toBeNull();
});

test('it fails a token whose payload was edited', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  const [header = '', claims = '', signature = ''] = token.split('.');

  const edited = Buffer.from(
    Buffer.from(claims, 'base64url').toString().replace('dev-7f3a', 'other'),
  ).toString('base64url');

  await expect(ctx.verify(`${header}.${edited}.${signature}`, 1010)).resolves.toBeNull();
});

test('it fails a token of a retired key', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  await expect(
    ctx.verify(token, 1010, { documents: [ctx.issuer.retire(1000)] }),
  ).resolves.toBeNull();
});

test('it fails a token past its expiry', async () => {
  const ctx = await setupTest();

  const token = await ctx.issuer.signToken({
    id: 'imp-1',
    name: 'dev-7f3a',
    audience: 'tasks.imp.internal',
    iat: 1000,
  });

  await expect(ctx.verify(token, 1061)).resolves.toBeNull();
});

test('it keeps the tokens of two issuers apart', async () => {
  const ctx = await setupTest();
  const other = await createTestIdentityIssuer({ issuer: 'host-b' });

  const claims = { id: 'imp-1', name: 'dev-7f3a', audience: 'tasks.imp.internal', iat: 1000 };

  const own = await ctx.issuer.signToken(claims);
  const foreign = await other.signToken(claims);

  const documents = [ctx.issuer.document, other.document];

  const crossed = [
    await ctx.verify(foreign, 1010),
    await ctx.verify(own, 1010, { documents: [other.document] }),
  ];

  const ownBoth = await ctx.verify(own, 1010, { documents });
  const foreignBoth = await ctx.verify(foreign, 1010, { documents });

  expect([...crossed, ownBoth?.issuer, foreignBoth?.issuer]).toStrictEqual([
    null,
    null,
    'host-a',
    'host-b',
  ]);
});
