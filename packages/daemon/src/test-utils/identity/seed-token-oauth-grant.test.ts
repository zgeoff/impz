import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { createRevocations } from '../../identity/auth/revocations';
import { createImpdMcpAuth } from '../../identity/oauth/create-impd-mcp-auth';
import { createTestDatabase } from '../platform/create-test-database';
import { seedTokenOAuthGrant } from './seed-token-oauth-grant';

async function setupTest() {
  const database = await createTestDatabase();

  const oauth = await createImpdMcpAuth({
    db: database.db,
    tokens: { findById: () => null },
    revocations: createRevocations(),
    config: { origin: 'https://imp.example', host: 'imp.example', port: 7171, serviceFiles: null },
    now: Date.now,
  });

  onTestFinished(() => oauth.admin.close());

  const server = oauth.server;

  invariant(server);

  return { db: database.db, oauth, server };
}

test('it writes a grant that names the imp token as its approver, with the imps it names', async () => {
  const ctx = await setupTest();

  const grant = await seedTokenOAuthGrant(ctx.server, ctx.db, {
    scope: 'exec',
    imps: null,
    tokenID: 'tok-1',
  });

  const grants = await ctx.oauth.admin.grants.list();

  const row = await ctx.db
    .selectFrom('user')
    .select('limits')
    .where('id', '=', grant.grantID)
    .executeTakeFirst();

  expect({ grants, limits: row?.limits }).toStrictEqual({
    grants: [expect.objectContaining({ grantID: grant.grantID, approvedBy: 'token:tok-1' })],
    limits: '{"imps":null,"grantable":false}',
  });
});
