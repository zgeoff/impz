import { expect, test } from 'bun:test';
import { ApprovalCodeSchema } from '@impz/api';
import invariant from 'tiny-invariant';
import { createPendingSignIn } from '../../../testing/identity/create-pending-sign-in';
import { runOAuthConsent } from '../../../testing/identity/run-oauth-consent';
import { runOAuthSignIn } from '../../../testing/identity/run-oauth-sign-in';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { makeOAuthResponder } from '../../../testing/surface/make-oauth-responder';
import { createRevocations } from '../auth/revocations';
import { loadTokenStore } from '../auth/token-store';
import { createMcpAuth } from './create-mcp-auth';

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
    db: database.db,
    revocations,
    tokens,
    auth,

    respond: makeOAuthResponder(auth),
  };
}

test('it signs a client in on an approval, and its access token acts within the approval', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read exec',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['dev-a']);
    },
  );

  const caller = await ctx.auth.resolveAccess(issued.access_token);

  expect(issued.scope).toBe('read exec offline_access');

  expect(caller).toStrictEqual({
    kind: 'oauth',
    name: expect.toStartWith('conn/'),
    scope: 'exec',
    imps: ['dev-a'],
    grantable: [],
    imageRefPrefix: null,
    tokenId: approver.tokenId,
    grantId: expect.toBeString(),
    expiresAt: null,
    principal: expect.toStartWith('grant:'),
    display: 'conn via laptop',
  });
});

test('it refuses an access token past its expiry', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.db
    .updateTable('oauthAccessToken')
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .execute();

  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
});

test('it refuses a bearer that is no access token it issued', async () => {
  const ctx = await setupTest();
  const access = await ctx.auth.resolveAccess('not-a-token-this-server-issued');

  expect(access).toBeNull();
});

test('it refuses a refresh token sent as the access token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const access = await ctx.auth.resolveAccess(issued.refresh_token);

  expect(access).toBeNull();
});

test('it refuses the access token of a removed grant, and ends what the grant opened', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const caller = await ctx.auth.resolveAccess(issued.access_token);

  invariant(typeof caller?.grantId === 'string');

  const ends = ctx.revocations.readSignal(caller.grantId);

  await ctx.auth.removeGrant(caller.grantId);

  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
  expect(ends?.aborted).toBe(true);
});

test('it ends the grant a removed token approved', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.tokens.remove('laptop');

  const access = await ctx.auth.resolveAccess(issued.access_token);
  const grants = await ctx.auth.listGrants();

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('it ends a grant whose approving token no longer holds its scope', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'exec', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'exec',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', undefined);
    },
  );

  await ctx.db.updateTable('tokens').set({ scope: 'read' }).execute();

  const reloaded = await loadTokenStore({
    db: ctx.db,
    rootToken: 'a-root-token-of-this-test',
    now: Date.now,
    onRemove: ctx.revocations.revoke,
    isFileKey: () => false,
  });

  const narrowed = createMcpAuth({
    db: ctx.db,
    tokens: reloaded,
    revocations: ctx.revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
  });

  const access = await narrowed.resolveAccess(issued.access_token);
  const grants = await narrowed.listGrants();

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('it refreshes a grant’s tokens and refuses its spent refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const sendRefresh = () =>
    ctx.respond(
      new Request('http://127.0.0.1:7171/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.clientId,
          refresh_token: issued.refresh_token,
        }),
      }),
    );

  const first = await sendRefresh();
  const second = await sendRefresh();

  expect(first.status).toBe(200);
  expect(second.status).toBe(400);
});

test('it keeps the grant when another client presents its spent refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const other = await ctx.auth.addClient('other', ['https://other.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const sendRefresh = (clientID: string) =>
    ctx.respond(
      new Request('http://127.0.0.1:7171/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientID,
          refresh_token: issued.refresh_token,
        }),
      }),
    );

  const own = await sendRefresh(client.clientId);
  const tokens: unknown = await own.json();

  invariant(own.status === 200);
  invariant(typeof tokens === 'object' && tokens !== null && 'access_token' in tokens);
  invariant(typeof tokens.access_token === 'string');

  const foreign = await sendRefresh(other.clientId);
  const caller = await ctx.auth.resolveAccess(tokens.access_token);

  expect(foreign.status).toBe(400);
  expect(caller).toMatchObject({ kind: 'oauth' });
});

test('it ends the grant when two refreshes spend one refresh token at once', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const sendRefresh = () =>
    ctx.respond(
      new Request('http://127.0.0.1:7171/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: client.clientId,
          refresh_token: issued.refresh_token,
        }),
      }),
    );

  const answers = await Promise.all([sendRefresh(), sendRefresh()]);
  const grants = await ctx.db.selectFrom('user').select('id').execute();
  const accessRows = await ctx.db.selectFrom('oauthAccessToken').select('id').execute();

  expect(answers.map((answer) => answer.status)).toIncludeSameMembers([200, 400]);
  expect(grants).toStrictEqual([]);
  expect(accessRows).toStrictEqual([]);
});

test('it refuses an access token bound to a key, as the route takes bearer tokens alone', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  // what better-auth stores for a token it bound to a DPoP key
  await ctx.db
    .updateTable('oauthAccessToken')
    .set({ confirmation: JSON.stringify({ jkt: '0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I' }) })
    .execute();

  const caller = await ctx.auth.resolveAccess(issued.access_token);

  expect(caller).toBeNull();
});

test('it answers a token request that sends a DPoP proof with a bearer token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const refreshed = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: 'a.dpop.proof' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: issued.refresh_token,
      }),
    }),
  );

  const body: unknown = await refreshed.json();

  expect(refreshed.status).toBe(200);
  expect(body).toMatchObject({ token_type: 'Bearer' });
});

test.each([
  [
    'no PKCE challenge',
    {
      response_type: 'code',
      redirect_uri: 'https://client.example/callback',
      state: 'st',
      scope: 'read',
      resource: 'http://127.0.0.1:7171/mcp',
    },
    'invalid_request',
  ],
  [
    'a plain PKCE challenge',
    {
      response_type: 'code',
      redirect_uri: 'https://client.example/callback',
      code_challenge: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      code_challenge_method: 'plain',
      state: 'st',
      scope: 'read',
      resource: 'http://127.0.0.1:7171/mcp',
    },
    'invalid_request',
  ],
  [
    'another resource',
    {
      response_type: 'code',
      redirect_uri: 'https://client.example/callback',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      state: 'st',
      scope: 'read',
      resource: 'https://other.example/mcp',
    },
    'invalid_target',
  ],
])('it returns a sign-in with %s to the client with no login page', async (_what, query, error) => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const params = new URLSearchParams({ ...query, client_id: client.clientId });

  const authorized = await ctx.respond(
    new Request(`http://127.0.0.1:7171/oauth2/authorize?${params.toString()}`),
  );

  const back = new URL(authorized.headers.get('location') ?? '', 'http://127.0.0.1:7171');

  expect({
    status: authorized.status,
    target: `${back.origin}${back.pathname}`,
    error: back.searchParams.get('error'),
    state: back.searchParams.get('state'),
    iss: back.searchParams.get('iss'),
  }).toStrictEqual({
    status: 302,
    target: 'https://client.example/callback',
    error,
    state: 'st',
    iss: 'http://127.0.0.1:7171',
  });
});

test('it refuses a code exchange whose PKCE verifier does not match the challenge', async () => {
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
        code_verifier: 'not-the-verifier-whose-challenge-the-sign-in-sent',
        resource: 'http://127.0.0.1:7171/mcp',
      }),
    }),
  );

  expect({ status: exchanged.status, body: await exchanged.json() }).toStrictEqual({
    status: 400,
    body: { error: 'invalid_grant', error_description: 'code verification failed' },
  });
});

test('it refuses a code exchange with no PKCE verifier', async () => {
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
        resource: 'http://127.0.0.1:7171/mcp',
      }),
    }),
  );

  expect({ status: exchanged.status, body: await exchanged.json() }).toStrictEqual({
    status: 400,
    body: {
      error: 'invalid_request',
      error_description: 'Either code_verifier or client_secret is required',
    },
  });
});

test('it refuses a code exchange for another resource', async () => {
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
        resource: 'https://other.example/mcp',
      }),
    }),
  );

  expect({ status: exchanged.status, body: await exchanged.json() }).toStrictEqual({
    status: 400,
    body: { error: 'invalid_target', error_description: 'requested resource not authorized' },
  });
});

test('it binds a code exchanged with no resource to the route’s resource', async () => {
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
      }),
    }),
  );

  const stored = await ctx.db.selectFrom('oauthAccessToken').select('resources').execute();

  expect(exchanged.status).toBe(200);
  expect(stored).toStrictEqual([{ resources: '["http://127.0.0.1:7171/mcp"]' }]);
});

test('it refuses an access token bound to another resource', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
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

  await ctx.db
    .updateTable('oauthAccessToken')
    .set({ resources: '["https://other.example/mcp"]' })
    .execute();

  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
});

test('#listGrants lists a signed-in grant with its client, token, scope and imps', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'manage',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'exec', ['web-*']);
    },
  );

  const grants = await ctx.auth.listGrants();

  expect(grants).toStrictEqual([
    {
      id: expect.toBeString(),
      client: 'conn',
      token: 'laptop',
      scope: 'exec',
      imps: ['web-*'],
      createdAt: expect.toBeValidDate(),
      lastUsedAt: null,
    },
  ]);
});

test('#removeClient removes the grants its client holds', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.auth.removeClient('conn');

  const grants = await ctx.db.selectFrom('user').select('id').execute();
  const access = await ctx.auth.resolveAccess(issued.access_token);

  expect(access).toBeNull();
  expect(grants).toStrictEqual([]);
});

test('#addClient refuses a name another client holds', async () => {
  const ctx = await setupTest();

  await ctx.auth.addClient('conn', ['https://client.example/callback']);

  expect(ctx.auth.addClient('conn', ['https://other.example/callback'])).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('#addClient refuses one of two adds of the same name that run at once', async () => {
  const ctx = await setupTest();

  const settled = await Promise.allSettled([
    ctx.auth.addClient('conn', ['https://client.example/callback']),
    ctx.auth.addClient('conn', ['https://other.example/callback']),
  ]);

  const clients = await ctx.auth.listClients();

  expect(settled).toIncludeSameMembers([
    { status: 'fulfilled', value: expect.objectContaining({ name: 'conn' }) as unknown },
    { status: 'rejected', reason: expect.objectContaining({ code: 'CONFLICT' }) as unknown },
  ]);

  expect(clients).toHaveLength(1);
});

test('#updateClient replaces the redirect URIs a client holds', async () => {
  const ctx = await setupTest();

  await ctx.auth.addClient('conn', ['https://client.example/callback']);
  await ctx.auth.updateClient('conn', ['https://client.example/next']);

  const clients = await ctx.auth.listClients();

  expect(clients).toStrictEqual([
    {
      name: 'conn',
      clientId: expect.toStartWith('impc_'),
      redirectUris: ['https://client.example/next'],
      createdAt: expect.toBeValidDate(),
    },
  ]);
});

test('#removeExpired removes a grant whose refresh token expired', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.db
    .updateTable('oauthRefreshToken')
    .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
    .execute();

  await ctx.db
    .updateTable('user')
    .set({ createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .execute();

  await ctx.auth.removeExpired();

  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(grants).toStrictEqual([]);
});

test('#removeExpired removes the expired tokens of a grant that keeps refreshing, and keeps its live refresh rows', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  const refreshed = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: issued.refresh_token,
      }),
    }),
  );

  invariant(refreshed.status === 200);

  const past = new Date(Date.now() - 1000).toISOString();

  await ctx.db.updateTable('oauthAccessToken').set({ expiresAt: past }).execute();

  await ctx.db
    .updateTable('oauthRefreshToken')
    .set({ expiresAt: past })
    .where('revoked', 'is not', null)
    .execute();

  await ctx.auth.removeExpired();

  const accessRows = await ctx.db.selectFrom('oauthAccessToken').select('id').execute();
  const refreshRows = await ctx.db.selectFrom('oauthRefreshToken').select('revoked').execute();
  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(accessRows).toStrictEqual([]);
  expect(refreshRows).toStrictEqual([{ revoked: null }]);
  expect(grants).toHaveLength(1);
});

test('#removeExpired never removes a grant with a live refresh token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  await ctx.db
    .updateTable('user')
    .set({ createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
    .execute();

  await ctx.auth.removeExpired();

  const grants = await ctx.db.selectFrom('user').select('id').execute();

  expect(grants).toHaveLength(1);
});

test('it logs an approval under oauth with the client and the approving token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('demo', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'operator', scope: 'manage', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const lines = captureImpdLogs();

  ctx.auth.approve(ApprovalCodeSchema.parse(pending.code), approver, 'read', undefined);

  expect(lines).toStrictEqual(['INFO impd.oauth a sign-in for demo approved by token operator']);
});

test('it logs a sign-in that waits for an approval under oauth with the client', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('demo', ['https://client.example/callback']);

  const lines = captureImpdLogs();

  await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  expect(lines).toStrictEqual([
    'INFO impd.oauth demo asks to sign in; it waits for impz oauth approve',
  ]);
});

test('it logs a client that signs in under oauth with the approving token', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('demo', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'operator', scope: 'manage', imps: ['dev-*'] });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const lines = captureImpdLogs();

  await runOAuthSignIn(
    {
      respond: ctx.respond,
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      ctx.auth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  expect(lines).toStrictEqual([
    'INFO impd.oauth demo asks to sign in; it waits for impz oauth approve',
    'INFO impd.oauth a sign-in for demo approved by token operator',
    'INFO impd.oauth demo signed in, approved by token operator',
  ]);
});

test('it shows the login page again on Continue before the sign-in is approved', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const continued = await ctx.respond(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const page = await continued.text();

  expect(continued.status).toBe(200);
  expect(page).toInclude(`impz oauth approve ${pending.code}`);
});

test('it returns a denied sign-in to the client with access_denied, its state and the issuer', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const denied = await ctx.respond(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'deny' }),
    }),
  );

  const back = new URL(denied.headers.get('location') ?? '');

  expect(`${back.origin}${back.pathname}`).toBe('https://client.example/callback');

  expect(Object.fromEntries(back.searchParams)).toStrictEqual({
    error: 'access_denied',
    error_description: 'the sign-in was denied',
    state: 'st',
    iss: 'http://127.0.0.1:7171',
  });
});

test('it refuses a login form posted from another origin', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  const posted = await ctx.respond(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://attacker.example',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'deny' }),
    }),
  );

  expect(posted.status).toBe(400);
  expect(posted.headers.get('location')).toBeNull();
});

test('it refuses a consent with no session from the sign-in', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const pending = await createPendingSignIn({
    respond: ctx.respond,
    origin: 'http://127.0.0.1:7171',
    clientID: client.clientId,
    redirectURI: 'https://client.example/callback',
    scope: 'read',
  });

  ctx.auth.approve(ApprovalCodeSchema.parse(pending.code), approver, 'read', undefined);

  const continued = await ctx.respond(
    new Request('http://127.0.0.1:7171/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: pending.oauthQuery, action: 'continue' }),
    }),
  );

  const consentURL = new URL(continued.headers.get('location') ?? '');

  const consentQuery = consentURL.search.slice(1);

  const allowed = await ctx.respond(
    new Request('http://127.0.0.1:7171/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://127.0.0.1:7171',
      },
      body: new URLSearchParams({ oauth_query: consentQuery, action: 'allow' }),
    }),
  );

  expect(allowed.status).toBe(400);
  expect(allowed.headers.get('location')).toBeNull();
});

test('it answers a revocation of a token it does not know with an empty 200', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const revoked = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, token: 'no-such-token' }),
    }),
  );

  const body = await revoked.text();

  expect(revoked.status).toBe(200);
  expect(body).toBe('');
});

test('it refuses a token request whose body is past 16 KiB', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const refreshToken = 'r'.repeat(16 * 1024);

  const refused = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: client.clientId,
        refresh_token: refreshToken,
      }),
    }),
  );

  const body: unknown = await refused.json();

  expect(refused.status).toBe(400);

  expect(body).toStrictEqual({
    error: 'invalid_request',
    error_description: 'the request body is missing or too large',
  });
});

test('it refuses a revocation whose body is past 16 KiB', async () => {
  const ctx = await setupTest();
  const client = await ctx.auth.addClient('conn', ['https://client.example/callback']);

  const token = 't'.repeat(16 * 1024);

  const refused = await ctx.respond(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, token }),
    }),
  );

  expect(refused.status).toBe(400);
});

test('it shows a sign-in for a client it does not know a page that says so', async () => {
  const ctx = await setupTest();

  const query = new URLSearchParams({
    response_type: 'code',
    client_id: 'impc_unknown',
    redirect_uri: 'https://client.example/callback',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });

  const authorized = await ctx.respond(
    new Request(`http://127.0.0.1:7171/oauth2/authorize?${query.toString()}`),
  );

  const errorURL = new URL(authorized.headers.get('location') ?? '', 'http://127.0.0.1:7171');

  const page = await ctx.respond(new Request(errorURL.href));
  const text = await page.text();

  expect(errorURL.pathname).toBe('/error');
  expect(page.status).toBe(400);
  expect(text).toInclude('This client is not one this host knows.');
});

test('it signs a client in on a clock of impd’s own that is not the wall clock', async () => {
  const ctx = await setupTest();

  const frozen = createMcpAuth({
    db: ctx.db,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: () => Date.UTC(2026, 0, 1),
  });

  const client = await frozen.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.tokens.authenticate(made.secret);

  invariant(approver);

  const issued = await runOAuthSignIn(
    {
      respond: makeOAuthResponder(frozen),
      origin: 'http://127.0.0.1:7171',
      clientID: client.clientId,
      redirectURI: 'https://client.example/callback',
      scope: 'read',
    },
    (code) => {
      frozen.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);
    },
  );

  expect(issued.scope).toBe('read offline_access');
});

test('it gives no OAuth handlers while the route is off', async () => {
  const ctx = await setupTest();

  const off = createMcpAuth({
    db: ctx.db,
    tokens: ctx.tokens,
    revocations: ctx.revocations,
    config: null,
    now: Date.now,
  });

  expect(off.handlers).toBeNull();
});
