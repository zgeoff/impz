import { expect, mock, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readMcpAnswer } from '@impz/mcp/test-utils/read-mcp-answer';
import { claimFreePorts } from '@impz/shared/test-utils/claim-free-ports';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { listApiCalls } from '../../platform/db/api-audit';
import { createImage } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';
import { seedOAuthGrant } from '../../test-utils/identity/seed-oauth-grant';
import { seedTokenOAuthGrant } from '../../test-utils/identity/seed-token-oauth-grant';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { captureImpdLogs } from '../../test-utils/platform/capture-impd-logs';
import { startTestImpd } from '../../test-utils/start-test-impd';
import { buildStubMcpTransport } from '../../test-utils/surface/build-stub-mcp-transport';
import { buildStubExecGuest } from '../../test-utils/vm/build-stub-exec-guest';
import { startStubExecAgent } from '../../test-utils/vm/start-stub-exec-agent';
import { buildImagePaths, buildImpPaths } from '../../vm/storage/data-layout';
import { createPublicHandler, startPublicListener } from './public-listener';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = randomUUID();

  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  // impd keeps the wall clock, because the OAuth server checks its tokens against it.
  const harness = await startTestImpd(stack, {
    rootToken,
    env: {
      IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
      IMP_MCP_PUBLIC_PORT: String(publicPort),
    },
  });

  const publicMcp = harness.config.publicMcp;

  invariant(publicMcp);

  const server = harness.impd.oauth.server;

  invariant(server);

  return Object.assign(harness, {
    stack,
    rootToken,
    publicMcp,
    seed: {
      grant: (input: Parameters<typeof seedOAuthGrant>[1]) => seedOAuthGrant(server, input),
      tokenGrant: (input: Parameters<typeof seedTokenOAuthGrant>[2]) =>
        seedTokenOAuthGrant(server, harness.db, input),
    },
    handle: createPublicHandler({
      config: publicMcp,
      oauth: harness.impd.oauth,
      mcp: harness.impd.api.publicMcp,
    }),
  });
}

test.each([
  ['GET', '/.well-known/oauth-authorization-server', 200],
  ['GET', '/.well-known/oauth-protected-resource', 200],
  ['GET', '/.well-known/oauth-protected-resource/mcp', 200],
  ['GET', '/error', 400],
  ['GET', '/login', 400],
  ['GET', '/consent', 400],
  ['HEAD', '/.well-known/oauth-authorization-server', 404],
  ['HEAD', '/login', 404],
  ['POST', '/.well-known/oauth-authorization-server', 404],
  ['GET', '/.well-known/oauth-authorization-server/', 404],
  ['GET', '/login/', 404],
  ['PUT', '/login', 404],
  ['GET', '/oauth2/token', 404],
  ['GET', '/oauth2/revoke', 404],
  ['POST', '/oauth2/authorize', 404],
  ['GET', '/elsewhere', 404],
  ['GET', '/', 401],
])('it answers %s %s with %d', async (method, path, status) => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171${path}`, { method, headers: { host: '127.0.0.1:7171' } }),
    null,
  );

  expect(response.status).toBe(status);
});

test.each([
  ['/.well-known/oauth-protected-resource/mcp'],
  ['/.well-known/oauth-protected-resource'],
])('it serves the protected resource metadata at %s', async (path) => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171${path}`, { headers: { host: '127.0.0.1:7171' } }),
    null,
  );

  const json: unknown = await response.json();

  const body = z.record(z.string(), z.unknown()).parse(json);

  expect(response.status).toBe(200);

  expect(body).toMatchObject({
    resource: 'http://127.0.0.1:7171/mcp',
    authorization_servers: ['http://127.0.0.1:7171'],
    bearer_methods_supported: ['header'],
    resource_name: 'imp',
  });

  expect(
    Object.keys(body).filter((key) => key.startsWith('introspection_') || key.startsWith('dpop_')),
  ).toStrictEqual([]);
});

test('it serves the authorization server metadata, with public clients only and nothing on introspection or DPoP', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/.well-known/oauth-authorization-server`, {
      headers: { host: '127.0.0.1:7171' },
    }),
    null,
  );

  const json: unknown = await response.json();

  const body = z.record(z.string(), z.unknown()).parse(json);

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');

  expect(body).toMatchObject({
    issuer: 'http://127.0.0.1:7171',
    authorization_endpoint: 'http://127.0.0.1:7171/oauth2/authorize',
    token_endpoint: 'http://127.0.0.1:7171/oauth2/token',
    code_challenge_methods_supported: expect.arrayContaining(['S256']) as unknown,
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
  });

  expect(
    Object.keys(body).filter((key) => key.startsWith('introspection_') || key.startsWith('dpop_')),
  ).toStrictEqual([]);
});

test.each([['/rpc/system/info'], ['/health'], ['/rpc/auth/login'], ['/exec'], ['/index.html']])(
  'it answers the private path %s with the same 404, even with the root token',
  async (path) => {
    const ctx = await setupTest();

    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171${path}`, {
        headers: { host: '127.0.0.1:7171', authorization: `Bearer ${ctx.rootToken}` },
      }),
      null,
    );

    expect({ status: response.status, body: await response.text() }).toStrictEqual({
      status: 404,
      body: 'not found',
    });
  },
);

test.each([['evil.example'], ['127.0.0.1:7070'], ['localhost:7171']])(
  'it answers the host %s, which the front did not route here, with a 403',
  async (host) => {
    const ctx = await setupTest();

    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/.well-known/oauth-authorization-server`, {
        headers: { host },
      }),
      null,
    );

    expect(response.status).toBe(403);
  },
);

test.each([
  ['no credentials', {}],
  [
    'a peer and forwarded headers',
    { 'x-forwarded-for': '100.101.102.103', 'x-imp-peer': '100.101.102.103' },
  ],
  [
    'a client address and a session cookie',
    { 'cf-connecting-ip': '127.0.0.1', cookie: 'imp_session=anything' },
  ],
])('it refuses /mcp with %s, as it takes only an OAuth access token', async (_what, headers) => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp"',
  });
});

test.each([['impat_guess.wrong'], [`impat_${'x'.repeat(43)}`]])(
  'it refuses /mcp with the access token %s, which it never issued',
  async (token) => {
    const ctx = await setupTest();

    const response = await ctx.handle(
      new Request('http://127.0.0.1:7171/mcp', {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      }),
      null,
    );

    expect({
      status: response.status,
      challenge: response.headers.get('www-authenticate'),
    }).toStrictEqual({
      status: 401,
      challenge:
        'Bearer error="invalid_token", resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp"',
    });
  },
);

test('it refuses /mcp with the root token, as it takes only an OAuth access token', async () => {
  const ctx = await setupTest();

  const response = await ctx.handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        authorization: `Bearer ${ctx.rootToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer error="invalid_token", resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp"',
  });
});

test('it refuses /mcp with a named imp token', async () => {
  const ctx = await setupTest();
  const named = await ctx.impd.tokens.create({ name: 'named', scope: 'manage', imps: null });

  const response = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        authorization: `Bearer ${named.secret}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    }),
    null,
  );

  expect({
    status: response.status,
    challenge: response.headers.get('www-authenticate'),
  }).toStrictEqual({
    status: 401,
    challenge:
      'Bearer error="invalid_token", resource_metadata="http://127.0.0.1:7171/.well-known/oauth-protected-resource/mcp"',
  });
});

test('it lists an exec grant’s tools over /mcp, without the manage ones', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const listing = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    null,
  );

  const json = await readMcpAnswer(listing);

  const ToolSchema = z.object({ name: z.string() });
  const listed = z.object({ result: z.object({ tools: z.array(ToolSchema) }) }).parse(json);

  expect(listed.result.tools.map((tool) => tool.name)).toContain('imp_exec');
  expect(listed.result.tools.map((tool) => tool.name)).not.toContain('imp_create');
});

test('it ends a grant’s running command when the grant is revoked', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const call = (async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.accessToken}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
        }),
      }),
      null,
    );

    return response.text();
  })();

  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  const [listed] = await ctx.impd.oauth.admin.grants.list();

  invariant(listed);

  await ctx.impd.oauth.admin.grants.revoke(listed.grantID);

  const text = await call;

  await waitFor(() => {
    expect(guest.closed).toStrictEqual(['sleepy']);
  });

  expect(text).toBe('');
});

test('it refuses /mcp to a revoked grant’s session', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const [listed] = await ctx.impd.oauth.admin.grants.list();

  invariant(listed);

  await ctx.impd.oauth.admin.grants.revoke(listed.grantID);

  const after = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    }),
    null,
  );

  expect(after.status).toBe(401);
});

test('it ends an open tool call stream once another process revokes its grant', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: ctx.impd.api.publicMcp,
    reverifyMs: 20,
  });

  const headers = {
    host: '127.0.0.1:7171',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${tokens.accessToken}`,
  };

  const opened = await handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await opened.text();

  const call = await handle(
    new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': opened.headers.get('mcp-session-id') ?? '' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
      }),
    }),
    null,
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  // A revoke in another process deletes the row and fires no onGrantRevoked here.
  await ctx.db.deleteFrom('user').where('id', '=', tokens.grantID).execute();

  const text = await call.text();

  expect(text).not.toInclude('"result"');
});

test('it ends the grant a removed token approved, and its running command', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);
  const tokenID = approver?.tokenId ?? null;

  invariant(tokenID !== null);

  const tokens = await ctx.seed.tokenGrant({
    scope: 'exec',
    imps: null,
    tokenID,
  });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const call = (async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.accessToken}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
        }),
      }),
      null,
    );

    return response.text();
  })();

  await waitFor(() => {
    expect(guest.requests).toHaveLength(1);
  });

  await ctx.impd.tokens.remove('laptop');

  const after = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
    }),
    null,
  );

  const text = await call;

  await waitFor(() => {
    expect(guest.closed).toStrictEqual(['sleepy']);
  });

  expect(after.status).toBe(401);
  expect(text).toBe('');
});

test('it lists only the read tools to a read grant', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.seed.grant({ scope: 'read', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const listing = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    }),
    null,
  );

  const json = await readMcpAnswer(listing);

  const ToolSchema = z.object({ name: z.string() });
  const listed = z.object({ result: z.object({ tools: z.array(ToolSchema) }) }).parse(json);

  expect(listed.result.tools.map((tool) => tool.name)).toStrictEqual([
    'imp_list',
    'imp_url',
    'imp_image_list',
    'imp_checkpoint_list',
    'imp_event_list',
  ]);
});

test('it names only the read tools in the instructions it gives a read grant', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.seed.grant({ scope: 'read', imps: ['home-*'] });

  const opened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  const json = await readMcpAnswer(opened);

  const initialized = z.object({ result: z.object({ instructions: z.string() }) }).parse(json);

  expect(initialized.result.instructions).toBe(
    'imp runs persistent Linux microVMs ("imps") that sleep when idle and wake on use. This server may touch imps matching home-*. This caller has the read scope, so it can only look: list imps, their URLs, the images, the checkpoints and what happened to the imps. Running commands, reading or writing files, and creating, checkpointing, forking or destroying an imp need a wider grant: exec or manage. Its tools: imp_list, imp_url, imp_image_list, imp_checkpoint_list, imp_event_list.',
  );
});

test.each([
  ['read', undefined, 'dev-a', 'a read grant'],
  ['exec', ['dev-*'], 'box', 'a grant for dev-*'],
] as const)(
  'it refuses an exec by a %s grant with patterns %p on %s, past %s, and audits nothing',
  async (scope, imps, name) => {
    const ctx = await setupTest();

    const guest = buildStubExecGuest();
    const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

    await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

    await createImage(ctx.db, image);

    await ctx.client.imps.create({ name: 'box' });

    const boxImp = await readImpByName(ctx.db, 'box');

    invariant(boxImp);

    const boxAgent = await startStubExecAgent(
      buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
      guest,
    );

    ctx.stack.defer(() => {
      boxAgent.close();
    });

    await ctx.client.imps.create({ name: 'dev-a' });

    const devaImp = await readImpByName(ctx.db, 'dev-a');

    invariant(devaImp);

    const devaAgent = await startStubExecAgent(
      buildImpPaths(ctx.dataDir, devaImp.id).vsockSocket,
      guest,
    );

    ctx.stack.defer(() => {
      devaAgent.close();
    });

    const tokens = await ctx.seed.grant({ scope, imps: imps ?? ['*'] });

    const mcpOpened = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 0,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      }),
      null,
    );

    await mcpOpened.text();

    const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

    const called = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.accessToken}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'imp_exec', arguments: { name, command: 'echo hi' } },
        }),
      }),
      null,
    );

    const text = await called.text();

    const data = text.split('\n').find((line) => line.startsWith('data: '));

    invariant(data !== undefined);

    const json: unknown = JSON.parse(data.slice('data: '.length));
    const item = z.object({ text: z.string() });
    const result = z.object({ result: z.object({ content: z.array(item) }) }).parse(json);

    const calls = await listApiCalls(ctx.db, null, 100, null);

    expect(result.result.content[0]?.text).toStartWith('FORBIDDEN:');
    expect(guest.requests).toStrictEqual([]);
    expect(calls.filter((call) => call.actor === 'oauth')).toStrictEqual([]);
  },
);

test('it audits a grant’s change under its client and grant id', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'dev-a' });

  const devaImp = await readImpByName(ctx.db, 'dev-a');

  invariant(devaImp);

  const devaAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, devaImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    devaAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['dev-*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const slept = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_sleep', arguments: { name: 'dev-a' } },
      }),
    }),
    null,
  );

  await slept.text();

  const [listed] = await ctx.impd.oauth.admin.grants.list();
  const calls = await listApiCalls(ctx.db, null, 100, null);

  invariant(listed);

  expect(
    calls.filter((call) => call.actor === 'oauth').map((call) => [call.procedure, call.actorName]),
  ).toStrictEqual([['imps.sleep', `${listed.clientName}/${listed.grantID}`]]);
});

test('it audits a grant’s change refused past its patterns as FORBIDDEN', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['dev-*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  const slept = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'imp_sleep', arguments: { name: 'box' } },
      }),
    }),
    null,
  );

  const text = await slept.text();
  const calls = await listApiCalls(ctx.db, null, 100, null);
  const [listed] = await ctx.impd.oauth.admin.grants.list();

  invariant(listed);

  expect(text).toInclude('FORBIDDEN:');

  expect(
    calls
      .filter((call) => call.actor === 'oauth')
      .map((call) => [call.procedure, call.actorName, call.outcome]),
  ).toStrictEqual([['imps.sleep', `${listed.clientName}/${listed.grantID}`, 'FORBIDDEN']]);
});

test('it serves the route on its own port, for its own host only', async () => {
  const ctx = await setupTest();

  const listener = startPublicListener({
    config: { ...ctx.publicMcp, port: 0 },
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  ctx.stack.defer(() => listener.stop());

  const url = `http://127.0.0.1:${String(listener.port)}/.well-known/oauth-authorization-server`;

  const [found, elsewhere] = await Promise.all([
    fetch(url, { headers: { host: '127.0.0.1:7171' } }),
    fetch(url),
  ]);

  expect(found.status).toBe(200);
  expect(elsewhere.status).toBe(403);
});

test('it closes the MCP transport when the listener stops', async () => {
  const ctx = await setupTest();

  const transport = buildStubMcpTransport();

  const listener = startPublicListener({
    config: { ...ctx.publicMcp, port: 0 },
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  ctx.stack.defer(() => listener.stop());

  await listener.stop();

  expect(transport.closes).toBe(1);
});

test('it logs where the listener serves the route', async () => {
  const ctx = await setupTest();

  const logs = captureImpdLogs();

  const listener = startPublicListener({
    config: { ...ctx.publicMcp, port: 0 },
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  ctx.stack.defer(() => listener.stop());

  expect(logs).toStrictEqual([`INFO impd.public public mcp on :0 for ${ctx.publicMcp.origin}`]);
});

test('it answers a request that throws with a bare 500, and logs the reason', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const logs = captureImpdLogs();

  const listener = startPublicListener({
    config: { ...ctx.publicMcp, port: 0 },
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport({ failure: new Error('the transport broke') }),
  });

  ctx.stack.defer(() => listener.stop());

  const response = await fetch(`http://127.0.0.1:${String(listener.port)}/mcp`, {
    method: 'POST',
    headers: { host: '127.0.0.1:7171', authorization: bearer },
  });

  const body = await response.text();

  expect(response.status).toBe(500);
  expect(body).toBe('internal error');
  expect(logs).toContain('WARNING impd.public public mcp: the transport broke');
});

test('it lifts the idle timeout from a tool call on /mcp', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const timeout = mock((): void => {});

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  const request = new Request('http://127.0.0.1:7171/mcp', {
    method: 'POST',
    headers: { host: '127.0.0.1:7171', authorization: bearer },
  });

  const response = await handle(request, { timeout, requestIP: () => null });

  await response.body?.cancel();

  expect(timeout).toHaveBeenCalledExactlyOnceWith(request, 0);
});

test('it keeps the idle timeout on a sign-in page', async () => {
  const ctx = await setupTest();

  const timeout = mock((): void => {});

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  await handle(
    new Request('http://127.0.0.1:7171/login', { headers: { host: '127.0.0.1:7171' } }),
    { timeout, requestIP: () => null },
  );

  expect(timeout).not.toHaveBeenCalled();
});

test('it takes 64 open tool calls at once', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: buildStubMcpTransport(),
  });

  const statuses = await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171', authorization: bearer },
        }),
        null,
      );

      await response.body?.cancel();

      return response.status;
    }),
  );

  expect(statuses).toStrictEqual(Array.from({ length: 64 }, () => 200));
});

test('it keeps a tool call’s slot until the tool ends, though its client goes', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171', authorization: bearer },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', authorization: bearer },
    }),
    null,
  );

  expect(refused.status).toBe(429);
});

test('it frees a tool call’s slot once the tool ends', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171', authorization: bearer },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: { host: '127.0.0.1:7171', authorization: bearer },
    }),
    null,
  );

  const [first] = transport.calls;

  invariant(first);

  first.end();

  const next = await waitFor(async () => {
    const response = await handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: { host: '127.0.0.1:7171', authorization: bearer },
      }),
      null,
    );

    expect(response.status).toBe(200);

    return response;
  });

  expect(refused.status).toBe(429);
  expect(next.status).toBe(200);
});

test('it reads at most 16 bodies at once for requests past every slot', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171', authorization: bearer },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const reads = Array.from({ length: 33 }, () => false);
  const outcomes: (number | 'waiting')[] = Array.from({ length: 33 }, () => 'waiting');

  for (const [index] of reads.entries()) {
    const body = new ReadableStream<Uint8Array>(
      {
        pull: () => {
          reads[index] = true;

          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );

    const request = new Request('http://127.0.0.1:7171/mcp', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        authorization: bearer,
        'content-type': 'application/json',
      },
      body,
    });

    void (async () => {
      const response = await handle(request, null);

      outcomes[index] = response.status;
    })();
  }

  await waitFor(() => {
    expect(reads.slice(0, 16)).toSatisfyAll((read: boolean) => read);
    expect(outcomes.slice(16)).toSatisfyAll((outcome: number | 'waiting') => outcome === 429);
  });

  expect(outcomes.slice(0, 16)).toStrictEqual(Array.from({ length: 16 }, () => 'waiting'));
  expect(reads.slice(16)).toStrictEqual(Array.from({ length: 17 }, () => false));
});

test('it lets a cancel through with every slot held, which stops its tool and frees a slot', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.accessToken}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  const refused = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }),
    }),
    null,
  );

  const cancelled = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 1 },
      }),
    }),
    null,
  );

  await waitFor(() => {
    expect(guest.signals).toContain('sleepy:15');
  });

  const next = await waitFor(async () => {
    const response = await ctx.handle(
      new Request(`http://127.0.0.1:7171/mcp`, {
        method: 'POST',
        headers: {
          host: '127.0.0.1:7171',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${tokens.accessToken}`,
          'mcp-session-id': mcpSession,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'ping' }),
      }),
      null,
    );

    await response.text();

    expect(response.status).toBe(200);

    return response;
  });

  expect(refused.status).toBe(429);
  expect(cancelled.status).toBe(202);
  expect(next.status).toBe(200);
});

test('it refuses a request that starts work with every slot held', async () => {
  const ctx = await setupTest();
  const grant = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const bearer = `Bearer ${grant.accessToken}`;
  const transport = buildStubMcpTransport();

  const handle = createPublicHandler({
    config: ctx.publicMcp,
    oauth: ctx.impd.oauth,
    mcp: transport,
  });

  await Promise.all(
    Array.from({ length: 64 }, async () => {
      const response = await handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: { host: '127.0.0.1:7171', authorization: bearer },
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  const refused = await handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        authorization: bearer,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'ping' }),
    }),
    null,
  );

  expect(refused.status).toBe(429);
});

test('it refuses a signed-in notification too large for the allowance with every slot held', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.accessToken}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  const reason = 'x'.repeat(20 * 1024);

  const large = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 2, reason },
      }),
    }),
    null,
  );

  expect(large.status).toBe(429);
  expect(guest.signals).toStrictEqual([]);
});

test('it ends a signed-in session with its DELETE with every slot held', async () => {
  const ctx = await setupTest();

  const guest = buildStubExecGuest();
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.client.imps.create({ name: 'box' });

  const boxImp = await readImpByName(ctx.db, 'box');

  invariant(boxImp);

  const boxAgent = await startStubExecAgent(
    buildImpPaths(ctx.dataDir, boxImp.id).vsockSocket,
    guest,
  );

  ctx.stack.defer(() => {
    boxAgent.close();
  });

  const tokens = await ctx.seed.grant({ scope: 'exec', imps: ['*'] });

  const mcpOpened = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'POST',
      headers: {
        host: '127.0.0.1:7171',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      }),
    }),
    null,
  );

  await mcpOpened.text();

  const mcpSession = mcpOpened.headers.get('mcp-session-id') ?? '';

  await Promise.all(
    Array.from({ length: 64 }, async (_, offset) => {
      const response = await ctx.handle(
        new Request(`http://127.0.0.1:7171/mcp`, {
          method: 'POST',
          headers: {
            host: '127.0.0.1:7171',
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${tokens.accessToken}`,
            'mcp-session-id': mcpSession,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: offset + 1,
            method: 'tools/call',
            params: { name: 'imp_exec', arguments: { name: 'box', command: 'sleepy' } },
          }),
        }),
        null,
      );

      await response.body?.cancel();
    }),
  );

  await waitFor(() => {
    expect(guest.requests).toHaveLength(64);
  });

  const ended = await ctx.handle(
    new Request(`http://127.0.0.1:7171/mcp`, {
      method: 'DELETE',
      headers: {
        host: '127.0.0.1:7171',
        authorization: `Bearer ${tokens.accessToken}`,
        'mcp-session-id': mcpSession,
      },
    }),
    null,
  );

  expect(ended.status).toBe(204);
});
