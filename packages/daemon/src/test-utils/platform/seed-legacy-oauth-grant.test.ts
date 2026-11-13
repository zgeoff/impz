import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { runMigrationsTo } from '../../platform/db/run-migrations';
import { createUnmigratedDatabase } from './create-unmigrated-database';
import { seedLegacyOAuthGrant } from './seed-legacy-oauth-grant';

async function setupTest() {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '045_add_imp_last_request');

  return { db };
}

test('it writes the grant, its client and its tokens as impd 6.12 wrote them', async () => {
  const ctx = await setupTest();

  await seedLegacyOAuthGrant(ctx.db, {
    grantID: 'grant-conn',
    clientID: 'impc_conn',
    clientName: 'conn',
    tokenID: 'tok-1',
    imps: ['dev-a'],
    tokens: [
      {
        kind: 'refresh',
        id: 'refresh-conn',
        token: 'refresh-of-conn',
        scopes: ['read', 'offline_access'],
        expiresInMs: 60_000,
        isRotated: true,
      },
      {
        kind: 'access',
        id: 'access-conn',
        token: 'access-of-conn',
        scopes: ['read', 'offline_access'],
        expiresInMs: 60_000,
        refreshID: 'refresh-conn',
      },
    ],
  });

  const grants = await sql`SELECT id, tokenId, imps FROM "user"`.execute(ctx.db);
  const client = await ctx.db.selectFrom('oauthClient').select(['clientId', 'name']).execute();

  const refresh = await ctx.db
    .selectFrom('oauthRefreshToken')
    .select(['token', 'userId', 'revoked'])
    .execute();

  const access = await ctx.db
    .selectFrom('oauthAccessToken')
    .select(['token', 'refreshId', 'scopes'])
    .execute();

  expect({ grants: grants.rows, client, refresh, access }).toStrictEqual({
    grants: [{ id: 'grant-conn', tokenId: 'tok-1', imps: '["dev-a"]' }],
    client: [{ clientId: 'impc_conn', name: 'conn' }],
    refresh: [
      {
        token: createHash('sha256').update('refresh-of-conn').digest('base64url'),
        userId: 'grant-conn',
        revoked: expect.toBeDateString(),
      },
    ],
    access: [
      {
        token: createHash('sha256').update('access-of-conn').digest('base64url'),
        refreshId: 'refresh-conn',
        scopes: '["read","offline_access"]',
      },
    ],
  });
});

test('it writes a client once for two of its grants', async () => {
  const ctx = await setupTest();

  for (const grantID of ['grant-a', 'grant-b']) {
    await seedLegacyOAuthGrant(ctx.db, {
      grantID,
      clientID: 'impc_conn',
      clientName: 'conn',
      tokenID: 'tok-1',
      imps: null,
      tokens: [],
    });
  }

  const clients = await ctx.db.selectFrom('oauthClient').select('clientId').execute();

  expect(clients).toStrictEqual([{ clientId: 'impc_conn' }]);
});
