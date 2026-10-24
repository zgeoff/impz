import { expect, test } from 'bun:test';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { createOAuthHandlers } from './create-oauth-handlers';
import { createSignIns } from './create-sign-ins';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test.each([
  ['an empty body', ''],
  ['a body that is not JSON', 'unauthorized'],
])('it passes on the server’s 401 to a code exchange, with %s, as it is', async (_what, answer) => {
  const ctx = await setupTest();

  const handlers = createOAuthHandlers({
    auth: {
      handler: () => Promise.resolve(new Response(answer, { status: 401 })),
      signIn: () => Promise.resolve(new Response(null, { status: 500 })),
      readSessionID: () => Promise.resolve(null),
      readSecret: () => Promise.resolve('a-secret-of-this-test'),
      readSessionCookie: () => Promise.resolve({ name: 'session', secure: false }),
    },
    db: ctx.db,
    signIns: createSignIns({ now: () => Date.UTC(2026, 0, 1) }),
    origin: 'http://127.0.0.1:7171',
    resource: 'http://127.0.0.1:7171/mcp',
    now: () => Date.UTC(2026, 0, 1),
    readApprover: () => null,
    removeGrantRows: () => Promise.resolve(),
  });

  const response = await handlers.runTokenRequest(
    new Request('http://127.0.0.1:7171/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'impc_conn',
        code: 'a-code-of-this-test',
        redirect_uri: 'https://client.example/callback',
        code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      }),
    }),
  );

  expect({ status: response.status, body: await response.text() }).toStrictEqual({
    status: 401,
    body: answer,
  });
});

test.each([
  ['an empty body', ''],
  ['a body that is not JSON', 'bad request'],
])('it passes on the server’s 400 to a revocation, with %s, as it is', async (_what, answer) => {
  const ctx = await setupTest();

  const handlers = createOAuthHandlers({
    auth: {
      handler: () => Promise.resolve(new Response(answer, { status: 400 })),
      signIn: () => Promise.resolve(new Response(null, { status: 500 })),
      readSessionID: () => Promise.resolve(null),
      readSecret: () => Promise.resolve('a-secret-of-this-test'),
      readSessionCookie: () => Promise.resolve({ name: 'session', secure: false }),
    },
    db: ctx.db,
    signIns: createSignIns({ now: () => Date.UTC(2026, 0, 1) }),
    origin: 'http://127.0.0.1:7171',
    resource: 'http://127.0.0.1:7171/mcp',
    now: () => Date.UTC(2026, 0, 1),
    readApprover: () => null,
    removeGrantRows: () => Promise.resolve(),
  });

  const response = await handlers.runRevoke(
    new Request('http://127.0.0.1:7171/oauth2/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'impc_conn', token: 'a-token-of-this-test' }),
    }),
  );

  expect({ status: response.status, body: await response.text() }).toStrictEqual({
    status: 400,
    body: answer,
  });
});
