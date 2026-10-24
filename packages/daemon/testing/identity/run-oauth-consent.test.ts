import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@impz/api';
import invariant from 'tiny-invariant';
import { createRevocations } from '../../src/identity/auth/revocations';
import { loadTokenStore } from '../../src/identity/auth/token-store';
import { createMcpAuth } from '../../src/identity/oauth/create-mcp-auth';
import { createTestDatabase } from '../platform/create-test-database';
import { makeOAuthResponder } from '../surface/make-oauth-responder';
import { runOAuthConsent } from './run-oauth-consent';

async function setupTest() {
  const database = await createTestDatabase();

  const revocations = createRevocations();

  const tokens = await loadTokenStore({
    db: database.db,
    rootToken: 'a-root-token-of-this-test',
    now: Date.now,
    onRemove: revocations.revoke,
    isFileKey: () => false,
  });

  const auth = createMcpAuth({
    db: database.db,
    tokens,
    revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
  });

  return {
    auth,
    tokens,
    respond: makeOAuthResponder(auth),
  };
}

test('it returns the code that the consent sends back to the client', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const code = await runOAuthConsent(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (approvalCode) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(approvalCode), approver, 'read', undefined);
    },
  );

  const exchanged = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        code,
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
        resource: 'http://127.0.0.1:7171/mcp',
      }),
    }),
  );

  expect(exchanged.status).toBe(200);
});

test('it throws, naming Continue, when nothing approves the sign-in', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  expect(
    runOAuthConsent(
      {
        respond: ctx.respond,
        origin: 'http://127.0.0.1:7171',
        clientID: client.clientId,
        redirectURI: 'https://client.example/callback',
        scope: 'read',
      },
      () => {},
    ),
  ).rejects.toThrowWithMessage(Error, /^Continue answered 200/u);
});
