import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { createRevocations } from '../../identity/auth/revocations';
import { createImpdMcpAuth } from '../../identity/oauth/create-impd-mcp-auth';
import { createTestDatabase } from '../platform/create-test-database';
import { seedOAuthGrant } from './seed-oauth-grant';

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

  return { db: database.db, server };
}

test('it signs a client in to a grant of the scope and imps it names', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'exec', imps: ['dev-*', 'web'] });
  const access = await ctx.server.verify(grant.accessToken);

  expect(access).toMatchObject({
    grantID: grant.grantID,
    scopes: ['read', 'exec'],
    limits: { imps: ['dev-*', 'web'], grantable: false },
  });
});

test('it hands back a refresh token that the token route takes', async () => {
  const ctx = await setupTest();
  const grant = await seedOAuthGrant(ctx.server, { scope: 'read', imps: ['*'] });

  const refreshed = await ctx.server.routes.token(
    new Request(`${ctx.server.issuer}${ctx.server.paths.machine.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: grant.refreshToken,
        client_id: grant.clientID,
        resource: ctx.server.resource,
      }),
    }),
    { socketAddress: null, connectingIP: null, userAgent: null },
  );

  expect(refreshed.status).toBe(200);
});
