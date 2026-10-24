import { expect, test } from 'bun:test';
import { createRevocations } from '../../src/identity/auth/revocations';
import { loadTokenStore } from '../../src/identity/auth/token-store';
import { createMcpAuth } from '../../src/identity/oauth/create-mcp-auth';
import { createTestDatabase } from '../platform/create-test-database';
import { makeOAuthResponder } from './make-oauth-responder';

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

  return { db: database.db, tokens, revocations };
}

test('it answers an OAuth route with the handler behind it', async () => {
  const ctx = await setupTest();

  const auth = await createMcpAuth({
    ...ctx,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
  });

  const respond = makeOAuthResponder(auth);

  const response = await respond(
    new Request('http://127.0.0.1:7171/.well-known/oauth-authorization-server'),
  );

  const metadata: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(metadata).toMatchObject({ issuer: 'http://127.0.0.1:7171' });
});

test('it answers a path the routes do not have with 404', async () => {
  const ctx = await setupTest();

  const auth = await createMcpAuth({
    ...ctx,
    config: { origin: 'http://127.0.0.1:7171', host: '127.0.0.1:7171', port: 7171 },
    now: Date.now,
  });

  const response = await makeOAuthResponder(auth)(new Request('http://127.0.0.1:7171/elsewhere'));
  const body = await response.text();

  expect(response.status).toBe(404);
  expect(body).toBe('not found');
});

test('it answers an OAuth path with 404 while the public route is off', async () => {
  const ctx = await setupTest();
  const auth = await createMcpAuth({ ...ctx, config: null, now: Date.now });

  const response = await makeOAuthResponder(auth)(
    new Request('http://127.0.0.1:7171/.well-known/oauth-authorization-server'),
  );

  expect(response.status).toBe(404);
});
