import { expect, test } from 'bun:test';
import { createRevocations } from '../../src/identity/auth/revocations';
import { loadTokenStore } from '../../src/identity/auth/token-store';
import { createMcpAuth } from '../../src/identity/oauth/create-mcp-auth';
import { createTestDatabase } from '../platform/create-test-database';
import { makeOAuthResponder } from '../surface/make-oauth-responder';
import { createPendingSignIn } from './create-pending-sign-in';

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
    log: () => {},
  });

  return {
    auth,
    respond: makeOAuthResponder(auth),
  };
}

test('it starts a sign-in and reads its approval code from the login page', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  expect(pending).toStrictEqual({
    code: expect.toSatisfy((code: string) => /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/v.test(code)),
    oauthQuery: expect.toInclude(`client_id=${client.clientId}`),
  });
});

test('it throws, naming authorize, for a client the route does not know', async () => {
  const ctx = await setupTest();

  expect(
    createPendingSignIn({
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: 'impc_unknown',
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    }),
  ).rejects.toThrowWithMessage(Error, /^authorize answered/u);
});
