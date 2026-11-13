import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { seedOAuthGrant } from '../../test-utils/identity/seed-oauth-grant';
import { seedTokenOAuthGrant } from '../../test-utils/identity/seed-token-oauth-grant';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createImpdMcpAuth } from './create-impd-mcp-auth';

async function setupTest() {
  const database = await createTestDatabase();

  const revocations = createRevocations();

  const grants: { remove: (tokenID: string) => Promise<void> } = {
    remove: () => Promise.resolve(),
  };

  const tokens = await loadTokenStore({
    db: database.db,
    rootToken: 'a-root-token-of-this-test',
    now: Date.now,
    onRemove: revocations.revoke,
    removeGrants: (tokenID) => grants.remove(tokenID),
    isFileKey: () => false,
  });

  const oauth = await createImpdMcpAuth({
    db: database.db,
    tokens,
    revocations,
    config: { origin: 'https://imp.example', host: 'imp.example', port: 7171 },
    now: Date.now,
  });

  onTestFinished(() => oauth.admin.close());

  grants.remove = oauth.removeTokenGrants;

  const server = oauth.server;

  invariant(server);

  return { db: database.db, revocations, tokens, oauth, server };
}

test('it reads the caller of a grant the owner approved, limited to the imps on the consent page', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'exec', imps: ['dev-*', 'web'] });
  const access = await ctx.server.verify(grant.accessToken);

  invariant(access);

  const caller = await ctx.oauth.readCaller(access);

  expect(caller).toStrictEqual({
    kind: 'oauth',
    name: expect.toEndWith(`/${grant.grantID}`),
    scope: 'exec',
    imps: ['dev-*', 'web'],
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: grant.grantID,
    expiresAt: null,
    principal: `grant:${grant.grantID}`,
    display: expect.toEndWith(' via passkey'),
  });
});

test('it reads the caller of a grant an imp token approved, under that token', async () => {
  const ctx = await setupTest();
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(made.secret);
  const tokenID = approver?.tokenId ?? null;

  invariant(tokenID !== null);

  const grant = await seedTokenOAuthGrant(ctx.server, ctx.db, {
    scope: 'exec',
    imps: ['dev-a'],
    tokenID,
  });

  const access = await ctx.server.verify(grant.accessToken);

  invariant(access);

  const caller = await ctx.oauth.readCaller(access);

  expect(caller).toMatchObject({
    scope: 'exec',
    imps: ['dev-a'],
    tokenId: tokenID,
    display: expect.toEndWith(' via laptop'),
  });
});

test('it lists a grant the owner approved, as the passkey approved it, with when it was made', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'read', imps: ['*'] });
  const grants = await ctx.oauth.admin.grants.list();

  expect(grants).toStrictEqual([
    expect.objectContaining({
      grantID: grant.grantID,
      approvedBy: 'passkey',
      scopes: ['read'],
      createdAt: expect.toBeDateString(),
    }),
  ]);
});

test('it ends a grant an imp token approved once the token is removed', async () => {
  const ctx = await setupTest();
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);
  const tokenID = approver?.tokenId ?? null;

  invariant(tokenID !== null);

  const grant = await seedTokenOAuthGrant(ctx.server, ctx.db, {
    scope: 'read',
    imps: null,
    tokenID,
  });

  await ctx.tokens.remove('laptop');

  const grants = await ctx.oauth.admin.grants.list();

  expect(grants).toStrictEqual([]);
  expect(ctx.revocations.isRevoked(grant.grantID)).toBeTrue();
});

test('it ends a grant whose approving token no longer holds its scope, and refuses the token', async () => {
  const ctx = await setupTest();
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'read', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);
  const tokenID = approver?.tokenId ?? null;

  invariant(tokenID !== null);

  const grant = await seedTokenOAuthGrant(ctx.server, ctx.db, {
    scope: 'exec',
    imps: null,
    tokenID,
  });

  const access = await ctx.server.verify(grant.accessToken);

  expect(access).toBeNull();
  expect(ctx.revocations.isRevoked(grant.grantID)).toBeTrue();
});

test('it ends the stream of a grant once the grant is revoked', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'read', imps: ['*'] });

  const signal = ctx.revocations.readSignal(grant.grantID);

  await ctx.oauth.admin.grants.revoke(grant.grantID);

  expect(signal?.aborted).toBeTrue();
});

test('it opens the admin calls alone when impd serves no public route', async () => {
  const database = await createTestDatabase();

  const oauth = await createImpdMcpAuth({
    db: database.db,
    tokens: { findById: () => null },
    revocations: createRevocations(),
    config: null,
    now: Date.now,
  });

  onTestFinished(() => oauth.admin.close());

  const clients = await oauth.admin.clients.list();

  expect({ server: oauth.server, clients }).toStrictEqual({
    server: null,
    clients: [],
  });
});
