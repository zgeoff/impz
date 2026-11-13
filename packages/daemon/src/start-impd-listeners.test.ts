import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { claimFreePorts } from '@impz/shared/test-utils/claim-free-ports';
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import invariant from 'tiny-invariant';
import { seedOAuthGrant } from './test-utils/identity/seed-oauth-grant';
import { captureImpdLogs } from './test-utils/platform/capture-impd-logs';
import { startTestImpd } from './test-utils/start-test-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = randomUUID();

  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  const harness = await startTestImpd(stack, {
    rootToken,
    env: {
      IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
      IMP_MCP_PUBLIC_PORT: String(publicPort),
    },
  });

  return Object.assign(harness, {
    stack,
    rootToken,
    publicURL: `http://127.0.0.1:${String(publicPort)}`,
  });
}

test.each([
  ['GET', '/.well-known/oauth-authorization-server', 200],
  ['GET', '/.well-known/oauth-protected-resource', 200],
  ['GET', '/.well-known/oauth-protected-resource/mcp', 200],
  ['POST', '/mcp', 401],
  ['GET', '/oauth2/authorize', 302],
  ['POST', '/oauth2/token', 400],
  ['POST', '/oauth2/revoke', 400],
  ['GET', '/login', 400],
  ['GET', '/consent', 400],
  ['GET', '/error', 400],
])('it answers %s %s on the public port impd opens with %d', async (method, path, status) => {
  const ctx = await setupTest();

  const response = await fetch(`${ctx.publicURL}${path}`, {
    method,
    headers: { host: '127.0.0.1:7171' },
    redirect: 'manual',
  });

  expect(response.status).toBe(status);
});

test.each([
  ['the rpc route', 'POST', '/rpc/imps/list', '127.0.0.1:7171'],
  ['the rpc route', 'GET', '/rpc/system/info', '127.0.0.1:7171'],
  ['the health check', 'GET', '/health', '127.0.0.1:7171'],
  ['the dashboard', 'GET', '/ui/', '127.0.0.1:7171'],
  ['the exec socket', 'GET', '/exec', '127.0.0.1:7171'],
  ['the tunnel socket', 'GET', '/tunnel', '127.0.0.1:7171'],
  ['the build context upload', 'POST', '/images/build-context?name=web', '127.0.0.1:7171'],
  ['a move step', 'POST', '/move/prepare', '127.0.0.1:7171'],
])(
  'it answers %s (%s %s for host %s) on the public port with the same 404, even with the root token',
  async (_route, method, path, host) => {
    const ctx = await setupTest();

    const response = await fetch(`${ctx.publicURL}${path}`, {
      method,
      headers: {
        host,
        authorization: `Bearer ${ctx.rootToken}`,
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });

    expect({ status: response.status, body: await response.text() }).toStrictEqual({
      status: 404,
      body: 'not found',
    });
  },
);

test.each([['/'], ['/mcp']])(
  'it refuses an imp’s wake route (GET %s for host dev.imp.example) on the public port, even with the root token',
  async (path) => {
    const ctx = await setupTest();

    const response = await fetch(`${ctx.publicURL}${path}`, {
      headers: {
        host: 'dev.imp.example',
        authorization: `Bearer ${ctx.rootToken}`,
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
      },
    });

    expect(response.status).toBe(403);
  },
);

test('it opens no public port without IMP_MCP_PUBLIC_URL', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  const harness = await startTestImpd(stack, {
    rootToken: randomUUID(),
    env: { IMP_MCP_PUBLIC_PORT: String(publicPort) },
  });

  const reached = await fetch(
    `http://127.0.0.1:${String(publicPort)}/.well-known/oauth-authorization-server`,
  ).then(
    () => null,
    (error: unknown) => error,
  );

  expect(harness.impd.publicMcp).toBeNull();
  expect(reached).toMatchObject({ code: 'ECONNREFUSED' });
});

test('it logs the port of the API and its data dir, and the port of the broker, when it starts', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const lines = captureImpdLogs();

  const harness = await startTestImpd(stack);

  expect(lines).toContain(
    `INFO impd.api api on :${String(harness.config.apiPort)}, data in ${harness.dataDir}`,
  );

  expect(lines).toContain(
    `INFO impd.broker credential broker on :${String(harness.config.brokerPort)} of every imp's gateway`,
  );
});

test('it stops the API listener again without a failure when impd stops twice', async () => {
  const ctx = await setupTest();

  await ctx.impd.stop({ sleepImps: false });

  const steps = await ctx.impd.stop({ sleepImps: false });

  expect(steps).toContainEqual({ step: 'api', outcome: 'stopped' });
});

test('it sends an MCP SDK client with no token to sign in, and a grant’s token calls a tool', async () => {
  const ctx = await setupTest();

  const origin = 'http://127.0.0.1:7171';
  const server = ctx.impd.oauth.server;

  invariant(server);

  const grant = await seedOAuthGrant(server, { scope: 'read', imps: ['*'] });

  const sendThroughFront = (url: string | URL, init?: RequestInit): Promise<Response> => {
    const target = new URL(url);
    const headers = new Headers(init?.headers);

    headers.set('host', target.host);

    return fetch(`${ctx.publicURL}${target.pathname}${target.search}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
  };

  const buildProvider = (tokens: OAuthTokens | undefined) => {
    const saved: { discovery?: OAuthDiscoveryState; authorizationURL: URL | null } = {
      authorizationURL: null,
    };

    const provider: OAuthClientProvider = {
      redirectUrl: 'https://client.example/callback',
      clientMetadata: {
        client_name: 'conn',
        redirect_uris: ['https://client.example/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      clientInformation: () => ({ client_id: grant.clientID }),
      tokens: () => tokens,
      saveTokens: () => {},
      redirectToAuthorization: (url) => {
        saved.authorizationURL = url;
      },
      saveCodeVerifier: () => {},
      codeVerifier: () => '',
      saveDiscoveryState: (state) => {
        saved.discovery = state;
      },
      discoveryState: () => saved.discovery,
    };

    return { provider, saved };
  };

  const unsigned = buildProvider(undefined);

  const refused = await new Client({ name: 'test', version: '1.0.0' })
    .connect(
      new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
        authProvider: unsigned.provider,
        fetch: sendThroughFront,
      }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );

  const signed = buildProvider({
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    token_type: 'Bearer',
  });

  const client = new Client({ name: 'test', version: '1.0.0' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: signed.provider,
      fetch: sendThroughFront,
    }),
  );

  ctx.stack.defer(() => client.close());

  const called = await client.callTool({ name: 'imp_list', arguments: {} });

  expect(refused).toBeInstanceOf(UnauthorizedError);
  expect(unsigned.saved.authorizationURL?.href).toStartWith(`${origin}/oauth2/authorize?`);
  expect(called).toMatchObject({ isError: false });
});
