import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { readServiceToken } from '../../test-utils/identity/read-service-token';
import { seedOAuthGrant } from '../../test-utils/identity/seed-oauth-grant';
import { seedServiceFiles } from '../../test-utils/identity/seed-service-files';
import { seedTokenOAuthGrant } from '../../test-utils/identity/seed-token-oauth-grant';
import { buildHeldTransaction } from '../../test-utils/platform/build-held-transaction';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createImpdMcpAuth } from './create-impd-mcp-auth';
import type { ServiceFiles } from './public-mcp-config';

async function setupTest() {
  const database = await createTestDatabase();

  const held = buildHeldTransaction(database.db);
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
    db: held.db,
    tokens,
    revocations,
    config: { origin: 'https://imp.example', host: 'imp.example', port: 7171, serviceFiles: null },
    now: Date.now,
  });

  onTestFinished(() => oauth.admin.close());

  grants.remove = oauth.removeTokenGrants;

  const server = oauth.server;

  invariant(server);

  const refresh = (clientID: string, refreshToken: string) =>
    server.routes.token(
      new Request(`${server.issuer}${server.paths.machine.token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientID,
          resource: server.resource,
        }),
      }),
      { socketAddress: null, connectingIP: null, userAgent: null },
    );

  const openServiceAuth = async (serviceFiles: ServiceFiles) => {
    const opened = await createImpdMcpAuth({
      db: held.db,
      tokens,
      revocations,
      config: { origin: 'https://imp.example', host: 'imp.example', port: 7171, serviceFiles },
      now: Date.now,
    });

    onTestFinished(() => opened.admin.close());

    const openedServer = opened.server;

    invariant(openedServer);

    return { oauth: opened, server: openedServer };
  };

  return { db: database.db, held, revocations, tokens, oauth, server, refresh, openServiceAuth };
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

test('it keeps a revoke made while an impd transaction is open, after that transaction rolls back', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'read', imps: ['*'] });

  await ctx.held.open();

  const revoking = ctx.oauth.admin.grants.revoke(grant.grantID);

  await ctx.held.rollBack();

  await revoking;

  const access = await ctx.server.verify(grant.accessToken);

  expect(access).toBeNull();
});

test('it keeps a refresh made while an impd transaction is open, after that transaction rolls back', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'read', imps: ['*'] });

  await ctx.held.open();

  const refreshing = ctx.refresh(grant.clientID, grant.refreshToken);

  await ctx.held.rollBack();

  const answered = await refreshing;
  const again = await ctx.refresh(grant.clientID, grant.refreshToken);

  expect(answered.status).toBe(200);
  expect(again.status).toBe(400);
});

test('it refuses the token request of a client after a restart with a token file that drops its digest', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const kept = { name: 'wringer-rw', scopes: ['exec'], imps: ['wringer-*'] } as const;
  const dropped = { name: 'wringer-ro', scopes: ['read'], imps: ['wringer-*'] } as const;

  const seeded = await seedServiceFiles(stack, 'https://imp.example/mcp', [dropped, kept]);
  const before = await ctx.openServiceAuth(seeded.files);

  const first = await readServiceToken(
    before.server,
    dropped.name,
    seeded.findSecret(dropped.name),
  );

  await seeded.writeTokenFile([kept]);

  const after = await ctx.openServiceAuth(seeded.files);

  const second = await readServiceToken(
    after.server,
    dropped.name,
    seeded.findSecret(dropped.name),
  );

  const other = await readServiceToken(after.server, kept.name, seeded.findSecret(kept.name));

  expect({ first: first.status, second: second.error, other: other.status }).toStrictEqual({
    first: 200,
    second: 'invalid_client',
    other: 200,
  });
});

test('it reads the caller of a service client from its entry, at the highest scope of its token', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const seeded = await seedServiceFiles(stack, 'https://imp.example/mcp', [
    { name: 'wringer-ro', scopes: ['read', 'exec'], imps: ['wringer-*'] },
  ]);

  const opened = await ctx.openServiceAuth(seeded.files);

  const token = await readServiceToken(
    opened.server,
    'wringer-ro',
    seeded.findSecret('wringer-ro'),
  );

  invariant(token.accessToken);

  const access = await opened.server.verify(token.accessToken);

  invariant(access);

  const caller = await opened.oauth.readCaller(access);

  expect(caller).toStrictEqual({
    kind: 'service',
    name: 'service:wringer-ro',
    scope: 'exec',
    imps: ['wringer-*'],
    grantable: [],
    imageRefPrefix: null,
    tokenId: null,
    grantId: null,
    expiresAt: null,
    principal: 'service:wringer-ro',
    display: 'service:wringer-ro via client credentials',
  });
});

test.each([
  ['a token file that is not JSON', 'tokenFile', 'not json', 'IMP_MCP_SERVICE_TOKEN_FILE'],
  ['a clients file that is not JSON', 'clientsFile', 'not json', 'IMP_MCP_SERVICE_CLIENTS_FILE'],
  [
    'a clients file with an empty imps list',
    'clientsFile',
    '{"clients":{"wringer-ro":{"imps":[]}}}',
    'IMP_MCP_SERVICE_CLIENTS_FILE',
  ],
  [
    'a clients file with a null imps list',
    'clientsFile',
    '{"clients":{"wringer-ro":{"imps":null}}}',
    'IMP_MCP_SERVICE_CLIENTS_FILE',
  ],
] as const)(
  'it refuses to open with %s, and names the variable',
  async (_what, file, text, variable) => {
    const ctx = await setupTest();

    const stack = new AsyncDisposableStack();

    onTestFinished(() => stack.disposeAsync());

    const seeded = await seedServiceFiles(stack, 'https://imp.example/mcp', [
      { name: 'wringer-ro', scopes: ['read'], imps: ['wringer-*'] },
    ]);

    await Bun.write(seeded.files[file], text);

    const opening = ctx.openServiceAuth(seeded.files);

    await expect(opening).rejects.toThrow(variable);
  },
);

test('it refuses to open when a service file is missing', async () => {
  const ctx = await setupTest();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const seeded = await seedServiceFiles(stack, 'https://imp.example/mcp', [
    { name: 'wringer-ro', scopes: ['read'], imps: ['wringer-*'] },
  ]);

  const missing = { ...seeded.files, clientsFile: `${seeded.files.clientsFile}.missing` };
  const opening = ctx.openServiceAuth(missing);

  await expect(opening).rejects.toThrow('IMP_MCP_SERVICE_CLIENTS_FILE');
});
