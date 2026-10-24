import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildMockBrokerRule } from '@impz/api/test-utils/build-mock-broker-rule';
import { buildMockOAuthConfig } from '@impz/api/test-utils/build-mock-oauth-config';
import { server } from '@impz/test-utils/mock-server';
import { waitFor } from '@impz/test-utils/wait-for';
import { HttpResponse, http } from 'msw';
import invariant from 'tiny-invariant';
import { buildStubHostRoutes } from '../../../../testing/host-net/build-stub-host-routes';
import { buildStubBrokerJwt } from '../../../../testing/network/build-stub-broker-jwt';
import { createStubBrokerTokenEndpoint } from '../../../../testing/network/create-stub-broker-token-endpoint';
import { runSql } from '../../../../testing/platform/run-sql';
import { startTestImpd } from '../../../../testing/start-test-impd';
import { createReachPolicy } from '../../../host-net/net/reach-policy';
import { readImpByName } from '../../../platform/db/imps';
import { readSecret, removeSecret, upsertSecret } from '../../../platform/db/secrets';
import type { SecretRecord } from '../../../platform/db/secrets';
import { createBroker } from '../broker-service';
import { resolvePublicUpstream } from '../tls/resolve-public-upstream';
import { buildValueFile, createSecretFiles } from './secret-files';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  const reach = createReachPolicy({
    subnet: harness.config.subnet,
    deny: [],
    ipv6: null,
    now: Date.now,
    ...buildStubHostRoutes().deps,
  });

  return Object.assign(harness, { stack, reach });
}

test('it sends the first refresh once the row is committed', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const seen: { row: SecretRecord | undefined } = { row: undefined };

  server.use(
    http.post('https://auth.example.com/oauth/token', async () => {
      seen.row = await readSecret(ctx.db, 'codex');
    }),
  );

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({
      tokenUrl: 'https://auth.example.com/oauth/token',
      clientId: 'fake-client',
      tokenFormat: 'json',
    }),
  });

  expect(tokens.requests).toStrictEqual([
    {
      contentType: 'application/json',
      accept: 'application/json',
      body: '{"grant_type":"refresh_token","refresh_token":"fake-refresh-0","client_id":"fake-client"}',
      refreshToken: 'fake-refresh-0',
    },
  ]);

  expect(seen.row?.name).toBe('codex');
});

test('it answers a signed-in oauth secret ready, with its account claims only', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: buildStubBrokerJwt({
      email: 'someone@example.com',
      sub: 'fake-subject',
      at_hash: 'x',
      c_hash: 'x',
      nonce: 'x',
      sid: 'x',
      jti: 'x',
    }),
    expires_in: 3600,
  });

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  const added: unknown = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  expect(added).toStrictEqual({
    name: 'codex',
    kind: 'oauth',
    rules: [{ host: 'api.example.com', header: 'authorization', scheme: 'bearer' }],
    imps: [],
    createdAt: expect.any(Date) as unknown,
    droppedGrants: 0,
    oauth: {
      ...config,
      status: 'ready',
      expiresAt: expect.any(Date) as unknown,
      refreshedAt: expect.any(Date) as unknown,
      error: null,
      idClaims: { email: 'someone@example.com', sub: 'fake-subject' },
    },
  });
});

test('it never shows a token of an oauth secret through the API', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const idToken = buildStubBrokerJwt({ email: 'someone@example.com' });

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    id_token: idToken,
    expires_in: 3600,
  });

  const added = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const listed = await ctx.client.secrets.list();
  const info = await ctx.client.system.info();
  const audit = await ctx.client.audit.list({});
  const calls = await ctx.client.audit.calls({});

  const everything = JSON.stringify([added, listed, info, audit, calls]);

  expect(everything).not.toMatch(/fake-(?:access|refresh)|eyJ/u);
});

test('it stores the rotated tokens in the value file', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const secret = await readSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  expect(stored).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh-1',
    accessToken: 'fake-access-1',
    idToken: null,
    expiresAt: expect.any(Number) as unknown,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it answers an oauth secret whose first refresh fails pending', async () => {
  const ctx = await setupTest();

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      () => HttpResponse.json({ error: 'unavailable' }, { status: 503 }),
      { once: true },
    ),
  );

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  const added = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: config,
  });

  expect(added.oauth).toStrictEqual({
    ...config,
    status: 'pending',
    expiresAt: null,
    refreshedAt: null,
    error: 'HTTP 503',
    idClaims: null,
  });
});

test('it lists an oauth secret whose refresh token is dead as needing a new sign-in', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: config,
  });

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth).toStrictEqual({
    ...config,
    status: 'needs_login',
    expiresAt: null,
    refreshedAt: null,
    error: 'invalid_grant',
    idClaims: null,
  });
});

test('it rejects an oauth secret without its token endpoint', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      rules: [buildMockBrokerRule()],
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind oauth needs a token URL and a client id',
  });
});

test('it rejects an oauth secret without hosts', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'kind oauth needs at least one host' });
});

test('it rejects a token endpoint on a preset secret', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'gh',
      kind: 'github',
      value: 'x',
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind github has no token URL or client id; they are for kind oauth',
  });
});

test('it rejects a token endpoint on a custom secret', async () => {
  const ctx = await setupTest();

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'x',
      rules: [buildMockBrokerRule()],
      oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
    }),
  ).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'kind custom has no token URL or client id; they are for kind oauth',
  });
});

test.each([
  [
    'a plain HTTP token URL',
    { tokenUrl: 'http://auth.example.com/token', clientId: 'app_imp', tokenFormat: 'form' },
    'tokenUrl',
  ],
  [
    'a client id with a space',
    { tokenUrl: 'https://auth.example.com/token', clientId: 'has space', tokenFormat: 'form' },
    'clientId',
  ],
  [
    'a token format it does not speak',
    { tokenUrl: 'https://auth.example.com/token', clientId: 'app_imp', tokenFormat: 'xml' },
    'tokenFormat',
  ],
])('it rejects %s', async (_, oauth, field) => {
  const ctx = await setupTest();

  const added = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],

    // input the contract refuses
    oauth: oauth as never,
  });

  expect(added).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    data: { issues: expect.toPartiallyContain({ path: ['oauth', field] }) },
  });
});

test('it sends nothing to the token endpoint for a refused oauth secret', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const added = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
  });

  expect(added).rejects.toMatchObject({ code: 'BAD_REQUEST' });

  const listed = await ctx.client.secrets.list();

  expect(tokens.requests).toStrictEqual([]);
  expect(listed).toStrictEqual([]);
});

test('it keeps the grant through a new refresh token for the same endpoint', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });
  tokens.issue('fake-refresh-new', { access_token: 'fake-access-2', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.grants.add({ name: 'dev', secret: 'codex' });

  const rotated = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-new',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
    replace: true,
  });

  expect(rotated.droppedGrants).toBe(0);

  expect(tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-new',
  ]);
});

test.each([
  ['token URL', { tokenUrl: 'https://auth.example.org/oauth/token' }],
  ['client', { clientId: 'fake-other' }],
  ['token format', { tokenFormat: 'json' }],
] as const)('it refuses another %s without a rebind', async (_, override) => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const config = buildMockOAuthConfig({
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'fake-client',
    tokenFormat: 'form',
  });

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  expect(
    ctx.client.secrets.add({
      name: 'codex',
      kind: 'oauth',
      value: 'fake-refresh-0',
      rules: [buildMockBrokerRule({ host: 'api.example.com' })],
      oauth: { ...config, ...override },
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});

test('it takes another client and drops the grants on a rebind', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const config = buildMockOAuthConfig({
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'fake-client',
  });

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });
  tokens.issue('fake-refresh-0', { access_token: 'fake-access-2', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.grants.add({ name: 'dev', secret: 'codex' });

  const rebound = await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: { ...config, clientId: 'fake-other' },
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);
  expect(rebound.oauth?.clientId).toBe('fake-other');
});

test('it refreshes on request with the rotated token and answers after it', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
    expires_in: 3600,
  });

  tokens.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
    expires_in: 3600,
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const refreshed = await ctx.client.secrets.refresh({ name: 'codex' });
  const secret = await readSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  expect(refreshed.oauth?.status).toBe('ready');

  expect(tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
  ]);

  expect(stored).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh-2',
    accessToken: 'fake-access-2',
    idToken: null,
    expiresAt: expect.any(Number) as unknown,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it answers a forced refresh of a dead refresh token as needing a new sign-in', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);
  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  server.use(
    http.post('https://auth.example.com/oauth/token', () => HttpResponse.json({}, { status: 401 })),
  );

  const dead = await ctx.client.secrets.refresh({ name: 'codex' });

  expect(dead.oauth?.status).toBe('needs_login');
  expect(dead.oauth?.error).toBe('HTTP 401');
});

test('it refuses a refresh of a secret that is not oauth', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'ghp_x' });

  expect(ctx.client.secrets.refresh({ name: 'gh' })).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'secret gh is not an oauth secret',
  });
});

test('it refuses a refresh of a secret that does not exist', async () => {
  const ctx = await setupTest();

  expect(ctx.client.secrets.refresh({ name: 'nothing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'nothing' },
  });
});

test('it holds a replace behind a refresh under way, which never overwrites it', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  const config = buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' });

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-1',
    refresh_token: 'fake-refresh-1',
  });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;
      },
      { once: true },
    ),
  );

  tokens.issue('fake-refresh-1', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
  });

  tokens.issue('fake-refresh-replacement', {
    access_token: 'fake-access-3',
    refresh_token: 'fake-refresh-3',
  });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;

  const replacing = ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-replacement',
    rules: [buildMockBrokerRule({ host: 'api.example.com' })],
    oauth: config,
    replace: true,
  });

  gate.resolve();

  await Promise.all([refreshing, replacing]);

  const secret = await readSecret(ctx.db, 'codex');

  invariant(secret);

  const text = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  const stored: unknown = JSON.parse(text);

  expect(tokens.requests.map((request) => request.refreshToken)).toStrictEqual([
    'fake-refresh-0',
    'fake-refresh-1',
    'fake-refresh-replacement',
  ]);

  expect(stored).toStrictEqual({
    // oxlint-disable-next-line id-length -- `v` is the OAuth state file's version field
    v: 1,
    refreshToken: 'fake-refresh-3',
    accessToken: 'fake-access-3',
    idToken: null,
    expiresAt: null,
    refreshedAt: expect.any(Number) as unknown,
    status: 'ready',
    error: null,
  });
});

test('it holds a delete behind a refresh under way, then removes the secret', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);
  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const seen: { row: SecretRecord | undefined } = { row: undefined };

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;

        seen.row = await readSecret(ctx.db, 'codex');
      },
      { once: true },
    ),
  );

  tokens.issue('fake-refresh-0', {
    access_token: 'fake-access-2',
    refresh_token: 'fake-refresh-2',
  });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;

  const deleting = ctx.client.secrets.delete({ name: 'codex' });

  gate.resolve();

  expect(refreshing).rejects.toMatchObject({ code: 'NOT_FOUND' });

  await deleting;

  const gone = await readSecret(ctx.db, 'codex');

  expect(seen.row?.name).toBe('codex');
  expect(gone).toBeUndefined();
});

test('it answers not found for a secret deleted outside the lock during its refresh', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);
  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();

  server.use(
    http.post(
      'https://auth.example.com/oauth/token',
      async () => {
        reached.resolve();

        await gate.promise;
      },
      { once: true },
    ),
  );

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-2' });

  const refreshing = ctx.client.secrets.refresh({ name: 'codex' });

  await reached.promise;
  await removeSecret(ctx.db, 'codex');

  gate.resolve();

  expect(refreshing).rejects.toMatchObject({
    code: 'NOT_FOUND',
    data: { kind: 'secret', name: 'codex' },
  });
});

test('it shows an oauth secret whose value file is gone as needing a new sign-in', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);
  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1' });

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  const secret = await readSecret(ctx.db, 'codex');

  invariant(secret);

  await rm(join(ctx.dataDir, 'secrets', secret.valueFile));

  const listed = await ctx.client.secrets.list();

  expect(listed[0]?.oauth?.status).toBe('needs_login');
  expect(listed[0]?.oauth?.error).toBe('value file missing or unreadable');
});

test('it refreshes a pending secret when the broker starts', async () => {
  const ctx = await setupTest();

  const tokens = createStubBrokerTokenEndpoint('https://auth.example.com/oauth/token');

  server.use(tokens.handler);

  server.use(
    http.post('https://auth.example.com/oauth/token', () => HttpResponse.error(), { once: true }),
  );

  await ctx.client.secrets.add({
    name: 'codex',
    kind: 'oauth',
    value: 'fake-refresh-0',
    rules: [buildMockBrokerRule()],
    oauth: buildMockOAuthConfig({ tokenUrl: 'https://auth.example.com/oauth/token' }),
  });

  tokens.issue('fake-refresh-0', { access_token: 'fake-access-1', expires_in: 3600 });

  const started = await createBroker({
    config: ctx.config,
    db: ctx.db,
    reach: ctx.reach,
    resolveUpstream: resolvePublicUpstream,
  });

  ctx.stack.defer(() => started.stop());

  const sent = await waitFor(() => {
    const [request] = tokens.requests;

    invariant(request);

    return request.refreshToken;
  });

  expect(sent).toBe('fake-refresh-0');
});

test('it keeps the generation and the grants through a rotation that reorders the hosts', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const ruleA = buildMockBrokerRule({ host: 'a.example.com' });
  const ruleB = buildMockBrokerRule({ host: 'b.example.com' });

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules: [ruleA, ruleB] });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);

  const rotated = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [ruleB, ruleA],
    replace: true,
  });

  const after = await readSecret(ctx.db, 'api');

  invariant(after);

  const dev = await readImpByName(ctx.db, 'dev');

  invariant(dev);

  const isGranted = await ctx.impd.broker.isGranted(dev.id, 'b.example.com');
  const value = await readFile(join(ctx.dataDir, 'secrets', after.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(rotated.droppedGrants).toBe(0);
  expect(after.generation).toBe(before.generation);
  expect(value).toBe('v2');
  expect(files).toStrictEqual([after.valueFile]);
  expect(isGranted).toBeTrue();
});

test('it refuses a changed binding without rebind and changes nothing', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const rules = [
    buildMockBrokerRule({ host: 'a.example.com' }),
    buildMockBrokerRule({ host: 'b.example.com' }),
  ];

  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });
  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const before = await readSecret(ctx.db, 'api');

  const refused = ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [buildMockBrokerRule({ host: 'c.example.com' })],
    replace: true,
  });

  expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    data: { kind: 'secret', name: 'api', reason: 'binding_changed' },
  });

  invariant(before);

  const after = await readSecret(ctx.db, 'api');
  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(after).toStrictEqual(before);
  expect(files).toStrictEqual([before.valueFile]);
  expect(grants).toStrictEqual(['api']);
});

test('it takes an upstream written another way as the same binding', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const rotated = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081/' }),
    ],
    replace: true,
  });

  expect(rotated.droppedGrants).toBe(0);

  expect(rotated.rules).toStrictEqual([
    {
      host: 'svc.imp.internal',
      header: 'authorization',
      scheme: 'bearer',
      upstream: 'http://172.17.0.1:18081',
    },
  ]);
});

test('it refuses another upstream without rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'v2',
      rules: [
        buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18082' }),
      ],
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { reason: 'binding_changed' } });
});

test('it refuses dropping the upstream without rebind', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  expect(
    ctx.client.secrets.add({
      name: 'api',
      kind: 'custom',
      value: 'v2',
      rules: [buildMockBrokerRule({ host: 'svc.imp.internal' })],
      replace: true,
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT', data: { reason: 'binding_changed' } });
});

test('it moves the upstream and drops the grant on a rebind', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'http://172.17.0.1:18081' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });

  const rebound = await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules: [
      buildMockBrokerRule({ host: 'svc.imp.internal', upstream: 'https://other.example.com' }),
    ],
    replace: true,
    rebind: true,
  });

  expect(rebound.droppedGrants).toBe(1);

  expect(rebound.rules).toStrictEqual([
    {
      host: 'svc.imp.internal',
      header: 'authorization',
      scheme: 'bearer',
      upstream: 'https://other.example.com',
    },
  ]);
});

test('it takes a new generation and drops every grant of the secret on a rebind', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.imps.create({ name: 'dev-2' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'a.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });
  await ctx.client.grants.add({ name: 'dev-2', secret: 'api' });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);

  const rebound = await ctx.client.secrets.add({
    name: 'api',
    kind: 'github',
    value: 'v2',
    replace: true,
    rebind: true,
  });

  const after = await readSecret(ctx.db, 'api');

  invariant(after);

  const rows = await ctx.db.selectFrom('grants').selectAll().execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(rebound.droppedGrants).toBe(2);
  expect(rebound.imps).toStrictEqual([]);
  expect(rows).toStrictEqual([]);
  expect(after.generation).not.toBe(before.generation);
  expect(files).toStrictEqual([after.valueFile]);
});

test('it gives no credential for a grant of another generation', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v1',
    rules: [buildMockBrokerRule({ host: 'a.example.com' })],
  });

  await ctx.client.grants.add({ name: 'dev', secret: 'api' });
  await ctx.db.updateTable('grants').set({ secret_generation: 'other' }).execute();

  const dev = await readImpByName(ctx.db, 'dev');

  invariant(dev);

  const isGranted = await ctx.impd.broker.isGranted(dev.id, 'a.example.com');
  const grants = await ctx.client.grants.list({ name: 'dev' });

  expect(isGranted).toBeFalse();
  expect(grants).toStrictEqual([]);
});

test('it leaves one file, the row’s, after two rotations at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules, replace: true }),
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true }),
  ]);

  const secret = await readSecret(ctx.db, 'api');

  invariant(secret);

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', secret.valueFile), 'utf8');

  expect(files).toStrictEqual([secret.valueFile]);
  expect(value).toBeOneOf(['v1', 'v2']);
});

test('it leaves only the files rows name after a rotation and a delete at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules, replace: true }),
    ctx.client.secrets.delete({ name: 'api' }),
  ]);

  const named = await ctx.db.selectFrom('secrets').select('value_file').execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual(named.map((row) => row.value_file));
});

test('it leaves only the files rows name after a delete and a create at once', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v0', rules });

  await Promise.allSettled([
    ctx.client.secrets.delete({ name: 'api' }),
    ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules }),
  ]);

  const named = await ctx.db.selectFrom('secrets').select('value_file').execute();
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual(named.map((row) => row.value_file));
});

test('it removes its new file and keeps the old value when a replace fails to commit', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);

  await runSql(
    ctx.db,
    `CREATE TRIGGER fail_update BEFORE UPDATE ON secrets
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`,
  );

  const replaced = ctx.client.secrets.add({
    name: 'api',
    kind: 'custom',
    value: 'v2',
    rules,
    replace: true,
  });

  expect(replaced).rejects.toSatisfy(
    (thrown: unknown) => thrown instanceof Error && !String(thrown).includes('v2'),
  );

  const after = await readSecret(ctx.db, 'api');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(after).toStrictEqual(before);
  expect(files).toStrictEqual([before.valueFile]);
});

test('it keeps aside a new file whose row never came, on the next start', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);
  createSecretFiles(ctx.dataDir).write(buildValueFile('api'), 'v2');

  await writeFile(join(ctx.dataDir, 'secrets', '.api.half-written'), 'v');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    reach: ctx.reach,
    resolveUpstream: resolvePublicUpstream,
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toIncludeSameMembers(['.orphaned', before.valueFile]);
});

test('it removes the old file of a committed replace, on the next start', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const next = buildValueFile('api');

  createSecretFiles(ctx.dataDir).write(next, 'v3');

  await upsertSecret(ctx.db, { name: 'api', kind: 'custom', rules, valueFile: next }, false);

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    reach: ctx.reach,
    resolveUpstream: resolvePublicUpstream,
  });

  ctx.stack.defer(() => restarted.stop());

  const files = await readdir(join(ctx.dataDir, 'secrets'));
  const value = await readFile(join(ctx.dataDir, 'secrets', next), 'utf8');

  expect(files).toStrictEqual([next]);
  expect(value).toBe('v3');
});

test('it logs an old file a replace could not remove, and serves the new value', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);

  // a directory where the old file was: its removal after the commit fails
  const oldFile = join(ctx.dataDir, 'secrets', before.valueFile);

  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true });

  const after = await readSecret(ctx.db, 'api');

  invariant(after);

  const value = await readFile(join(ctx.dataDir, 'secrets', after.valueFile), 'utf8');
  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(value).toBe('v2');
  expect(files).toIncludeSameMembers([before.valueFile, after.valueFile]);

  expect(ctx.logs).toContainEqual(
    expect.toStartWith('WARNING impd.broker could not remove an old secret value file: '),
  );
});

test('it removes on the next start the old file a replace could not, not keeping it aside', async () => {
  const ctx = await setupTest();

  const rules = [buildMockBrokerRule({ host: 'a.example.com' })];

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v1', rules });

  const before = await readSecret(ctx.db, 'api');

  invariant(before);

  // a directory where the old file was: its removal after the commit fails
  const oldFile = join(ctx.dataDir, 'secrets', before.valueFile);

  await rm(oldFile);
  await mkdir(oldFile);
  await writeFile(join(oldFile, 'held'), 'x');

  await ctx.client.secrets.add({ name: 'api', kind: 'custom', value: 'v2', rules, replace: true });

  await rm(oldFile, { recursive: true });
  await writeFile(oldFile, 'v1');

  const restarted = await createBroker({
    config: ctx.config,
    db: ctx.db,
    timer: ctx.tickers.timer,
    reach: ctx.reach,
    resolveUpstream: resolvePublicUpstream,
  });

  ctx.stack.defer(() => restarted.stop());

  const after = await readSecret(ctx.db, 'api');

  invariant(after);

  const files = await readdir(join(ctx.dataDir, 'secrets'));

  expect(files).toStrictEqual([after.valueFile]);
});
