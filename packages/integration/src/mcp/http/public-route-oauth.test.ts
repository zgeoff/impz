import { expect, onTestFinished, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ApprovalCodeSchema } from '@impz/api';
import { startTestImpd } from '@impz/daemon/testing';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
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

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const publicPort = claimFreePorts(1, {
    pick: () => 10_000 + Math.floor(Math.random() * 10_000),
  }).take();

  const harness = await startTestImpd(stack, {
    rootToken: randomUUID(),
    env: {
      IMP_MCP_PUBLIC_URL: 'http://127.0.0.1:7171',
      IMP_MCP_PUBLIC_PORT: String(publicPort),
    },
  });

  return Object.assign(harness, {
    stack,
    publicURL: `http://127.0.0.1:${String(publicPort)}`,
  });
}

test('it signs an MCP SDK client in over impd’s public port, and the grant calls a tool', async () => {
  const ctx = await setupTest();

  const origin = 'http://127.0.0.1:7171';

  const oauthClient = await ctx.impd.oauth.addClient('conn', ['https://client.example/callback']);
  const made = await ctx.impd.tokens.create({ name: 'laptop', scope: 'manage', imps: null });

  const approver = ctx.impd.tokens.authenticate(made.secret);

  invariant(approver);

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

  const saved: {
    tokens?: OAuthTokens;
    discovery?: OAuthDiscoveryState;
    verifier: string;
    authorizationURL: URL | null;
  } = { verifier: '', authorizationURL: null };

  const provider: OAuthClientProvider = {
    redirectUrl: 'https://client.example/callback',
    clientMetadata: {
      client_name: 'conn',
      redirect_uris: ['https://client.example/callback'],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    },
    clientInformation: () => ({ client_id: oauthClient.clientId }),
    tokens: () => saved.tokens,
    saveTokens: (tokens) => {
      saved.tokens = tokens;
    },
    redirectToAuthorization: (url) => {
      saved.authorizationURL = url;
    },
    saveCodeVerifier: (verifier) => {
      saved.verifier = verifier;
    },
    codeVerifier: () => saved.verifier,
    saveDiscoveryState: (state) => {
      saved.discovery = state;
    },
    discoveryState: () => saved.discovery,
  };

  const first = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    authProvider: provider,
    fetch: sendThroughFront,
  });

  const refused = await new Client({ name: 'test', version: '1.0.0' }).connect(first).then(
    () => null,
    (error: unknown) => error,
  );

  invariant(saved.authorizationURL);

  const authorized = await sendThroughFront(saved.authorizationURL);

  const loginURL = new URL(authorized.headers.get('location') ?? '', origin);

  const login = await sendThroughFront(loginURL);
  const loginPage = await login.text();

  const code = /impz oauth approve (?<code>[A-Z0-9\-]+)/v.exec(loginPage)?.groups?.['code'] ?? '';

  ctx.impd.oauth.approve(ApprovalCodeSchema.parse(code), approver, 'read', undefined);

  const continued = await sendThroughFront(`${origin}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin },
    body: new URLSearchParams({ oauth_query: loginURL.search.slice(1), action: 'continue' }),
  });

  const consentURL = new URL(continued.headers.get('location') ?? '', origin);

  const cookie = continued.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');

  const allowed = await sendThroughFront(`${origin}/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin, cookie },
    body: new URLSearchParams({ oauth_query: consentURL.search.slice(1), action: 'allow' }),
  });

  await first.finishAuth(new URL(allowed.headers.get('location') ?? '').searchParams);

  const client = new Client({ name: 'test', version: '1.0.0' });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
      authProvider: provider,
      fetch: sendThroughFront,
    }),
  );

  ctx.stack.defer(() => client.close());

  const called = await client.callTool({ name: 'imp_list', arguments: {} });

  expect(refused).toBeInstanceOf(UnauthorizedError);
  expect(saved.tokens?.scope).toBe('read offline_access');
  expect(called).toMatchObject({ isError: false });
});
