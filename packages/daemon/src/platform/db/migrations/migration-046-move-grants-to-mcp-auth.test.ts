import { expect, onTestFinished, test } from 'bun:test';
import type { GrantID, OAuthClientID } from '@zgeoff/mcp-auth';
import { toTagged } from '@zgeoff/std';
import { sql } from 'kysely';
import invariant from 'tiny-invariant';
import { createRevocations } from '../../../identity/auth/revocations';
import { loadTokenStore } from '../../../identity/auth/token-store';
import { createImpdMcpAuth } from '../../../identity/oauth/create-impd-mcp-auth';
import { buildMockTokenRecord } from '../../../test-utils/identity/build-mock-token-record';
import { createUnmigratedDatabase } from '../../../test-utils/platform/create-unmigrated-database';
import { seedLegacyOAuthGrant } from '../../../test-utils/platform/seed-legacy-oauth-grant';
import { runMigrations, runMigrationsTo } from '../run-migrations';
import { writeTokenRecord } from '../tokens';
import type { GrantableSecret } from '../tokens';

async function setupTest() {
  const db = createUnmigratedDatabase();

  await runMigrationsTo(db, '045_add_imp_last_request');

  const dayMs = 24 * 60 * 60_000;

  const openAuth = async () => {
    const revocations = createRevocations();

    const tokens = await loadTokenStore({
      db,
      rootToken: 'a-root-token-of-this-test',
      now: Date.now,
      onRemove: revocations.revoke,
      removeGrants: () => Promise.resolve(),
      isFileKey: () => false,
    });

    const oauth = await createImpdMcpAuth({
      db,
      tokens,
      revocations,
      config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
      now: Date.now,
    });

    onTestFinished(() => oauth.admin.close());

    const server = oauth.server;

    invariant(server);

    return server;
  };

  const writeApprover = async (grantable: readonly GrantableSecret[] = []) => {
    const record = buildMockTokenRecord({ name: 'laptop', scope: 'manage', imps: null, grantable });

    await writeTokenRecord(db, record, []);

    return record.id;
  };

  // An exec grant on dev-a, signed in once.
  const seedSignedIn = async (tokenID: string) => {
    await seedLegacyOAuthGrant(db, {
      grantID: 'grant-conn',
      clientID: 'impc_conn',
      clientName: 'conn',
      tokenID,
      imps: ['dev-a'],
      tokens: [
        {
          kind: 'refresh',
          id: 'refresh-conn',
          token: 'refresh-of-conn-0123456789abcdefgh',
          scopes: ['read', 'exec', 'offline_access'],
          expiresInMs: 30 * dayMs,
        },
        {
          kind: 'access',
          id: 'access-conn',
          token: 'access-of-conn-0123456789abcdefghi',
          scopes: ['read', 'exec', 'offline_access'],
          expiresInMs: 14 * 60_000,
          refreshID: 'refresh-conn',
        },
      ],
    });

    return {
      grantID: toTagged<GrantID>('grant-conn'),
      accessToken: 'access-of-conn-0123456789abcdefghi',
    };
  };

  return { db, dayMs, openAuth, writeApprover, seedSignedIn };
}

test('it keeps two grants, one refreshed, whose access tokens pass verify, and a revoke of one ends only it', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover();
  const first = await ctx.seedSignedIn(tokenID);

  // A read grant on every imp, whose client refreshed it once: the first refresh token is rotated,
  // and the first access token still lives beside the new one.
  await seedLegacyOAuthGrant(ctx.db, {
    grantID: 'grant-desk',
    clientID: 'impc_desk',
    clientName: 'desk',
    tokenID,
    imps: null,
    tokens: [
      {
        kind: 'refresh',
        id: 'refresh-desk-1',
        token: 'refresh-of-desk-0123456789abcdefg',
        scopes: ['read', 'offline_access'],
        expiresInMs: 30 * ctx.dayMs,
        isRotated: true,
      },
      {
        kind: 'refresh',
        id: 'refresh-desk-2',
        token: 'refresh-of-desk-9876543210abcdefg',
        scopes: ['read', 'offline_access'],
        expiresInMs: 30 * ctx.dayMs,
      },
      {
        kind: 'access',
        id: 'access-desk-1',
        token: 'access-of-desk-0123456789abcdefgh',
        scopes: ['read', 'offline_access'],
        expiresInMs: 13 * 60_000,
        refreshID: 'refresh-desk-1',
      },
      {
        kind: 'access',
        id: 'access-desk-2',
        token: 'access-of-desk-9876543210abcdefgh',
        scopes: ['read', 'offline_access'],
        expiresInMs: 14 * 60_000,
        refreshID: 'refresh-desk-2',
      },
    ],
  });

  await runMigrations(ctx.db);

  const server = await ctx.openAuth();

  const before = {
    first: await server.verify(first.accessToken),
    second: await server.verify('access-of-desk-9876543210abcdefgh'),
  };

  await server.grants.revoke(first.grantID);

  const after = {
    first: await server.verify(first.accessToken),
    second: await server.verify('access-of-desk-9876543210abcdefgh'),
  };

  expect({ before, after }).toStrictEqual({
    before: {
      first: {
        kind: 'oauth',
        grantID: first.grantID,
        clientID: toTagged<OAuthClientID>('impc_conn'),
        clientName: 'conn',
        scopes: ['read', 'exec'],
        limits: { imps: ['dev-a'], grantable: false },
      },
      second: {
        kind: 'oauth',
        grantID: toTagged<GrantID>('grant-desk'),
        clientID: toTagged<OAuthClientID>('impc_desk'),
        clientName: 'desk',
        scopes: ['read'],
        limits: { imps: null, grantable: false },
      },
    },
    after: {
      first: null,
      second: expect.objectContaining({ grantID: 'grant-desk' }),
    },
  });
});

test('it names the approving imp token on each grant it keeps', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover();

  await ctx.seedSignedIn(tokenID);

  await runMigrations(ctx.db);

  const server = await ctx.openAuth();
  const grants = await server.grants.list();

  expect(grants).toStrictEqual([
    {
      grantID: toTagged<GrantID>('grant-conn'),
      clientID: toTagged<OAuthClientID>('impc_conn'),
      clientName: 'conn',
      scopes: ['read', 'exec'],
      approvedBy: `token:${tokenID}`,
      createdAt: expect.toBeDateString(),
      lastUsedAt: null,
    },
  ]);
});

test('it records that the approving imp token could grant secrets', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover([{ name: 'gh', generation: 'gen-1' }]);
  const first = await ctx.seedSignedIn(tokenID);

  await runMigrations(ctx.db);

  const row = await ctx.db
    .selectFrom('user')
    .select('limits')
    .where('id', '=', first.grantID)
    .executeTakeFirst();

  expect(row?.limits).toBe('{"imps":["dev-a"],"grantable":true}');
});

test('it removes a grant with no live token, and its tokens with it', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover();

  await ctx.seedSignedIn(tokenID);

  await seedLegacyOAuthGrant(ctx.db, {
    grantID: 'grant-old',
    clientID: 'impc_old',
    clientName: 'old',
    tokenID,
    imps: null,
    tokens: [
      {
        kind: 'refresh',
        id: 'refresh-old',
        token: 'refresh-of-old-0123456789abcdefghi',
        scopes: ['read', 'offline_access'],
        expiresInMs: -60_000,
      },
    ],
  });

  await runMigrations(ctx.db);

  const grants = await ctx.db.selectFrom('user').select('id').execute();
  const refreshTokens = await ctx.db.selectFrom('oauthRefreshToken').select('id').execute();

  expect({ grants, refreshTokens }).toStrictEqual({
    grants: [{ id: 'grant-conn' }],
    refreshTokens: [{ id: 'refresh-conn' }],
  });
});

test('it leaves no foreign key that points at no row', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover();

  await ctx.seedSignedIn(tokenID);

  await runMigrations(ctx.db);

  const broken = await sql`PRAGMA foreign_key_check`.execute(ctx.db);

  expect(broken.rows).toStrictEqual([]);
});

test('it rolls the whole migration back when its foreign key check fails', async () => {
  const ctx = await setupTest();
  const tokenID = await ctx.writeApprover();

  await ctx.seedSignedIn(tokenID);

  // A refresh token whose client no row holds, as a write with foreign keys off leaves it.
  ctx.db.sqlite.run('PRAGMA foreign_keys = OFF');

  await sql`UPDATE oauthRefreshToken SET clientId = 'impc_gone'`.execute(ctx.db);

  ctx.db.sqlite.run('PRAGMA foreign_keys = ON');

  const migrated = runMigrations(ctx.db);

  expect(migrated).rejects.toThrow('the grant migration left 1 rows');

  await Promise.allSettled([migrated]);

  const columns = await sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info('user')`.execute(ctx.db);

  expect(columns.rows.map((column) => column.name)).toIncludeAllMembers(['tokenId', 'imps']);
});
