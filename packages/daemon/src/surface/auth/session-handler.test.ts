import { expect, mock, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { loadTokenStore } from '../../identity/auth/token-store';
import { readSession, readSessionCookies } from '../../platform/http/session-cookie';
import { createSessionHandler } from './session-handler';

async function setupTest() {
  const database = await createTestDatabase();

  return {
    loadTokens: (rootToken: string) =>
      loadTokenStore({
        db: database.db,
        rootToken,
        now: Date.now,
        onRemove: () => {},
        isFileKey: () => false,
      }),
  };
}

test('#login sets a session cookie naming the token, for 30 days', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');
  const made = await tokens.create({ name: 'viewer', scope: 'read', imps: null });

  const [tokenId = ''] = made.secret.slice('imp_'.length).split('.');

  const sessions = createSessionHandler({
    tokens,
    rootToken: 'root-secret',
    now: () => 1_800_000_000_000,
  });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: made.secret } }),
    }),
  );

  invariant(response);

  const [pair = ''] = (response.headers.get('set-cookie') ?? '').split(';');
  const [value] = readSessionCookies(pair);

  invariant(value !== undefined);

  expect(response.status).toBe(200);

  expect(readSession(value, 'root-secret', 1_800_000_000_000)).toStrictEqual({
    tokenId,
    expiresAt: 1_800_000_000_000 + 30 * 24 * 60 * 60 * 1000,
  });
});

test('#login sets an http-only strict cookie on / over plain HTTP', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-secret' } }),
    }),
  );

  invariant(response);

  const cookie = Bun.Cookie.parse(response.headers.get('set-cookie') ?? '');

  expect(cookie.toJSON()).toMatchObject({
    name: 'imp_session',
    value: expect.toStartWith('v2.root.'),
    path: '/',
    maxAge: 2_592_000,
    httpOnly: true,
    sameSite: 'strict',
    secure: false,
  });
});

test('#login sets the Secure __Host- cookie for an https request', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('https://imp.example.com/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-secret' } }),
    }),
  );

  invariant(response);

  const cookie = Bun.Cookie.parse(response.headers.get('set-cookie') ?? '');

  expect(cookie.toJSON()).toMatchObject({
    name: '__Host-imp_session',
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: true,
  });
});

test('#login sets the Secure __Host- cookie behind a TLS front that says so', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: {
        'sec-fetch-site': 'same-origin',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ json: { token: 'root-secret' } }),
    }),
  );

  invariant(response);

  expect(response.headers.get('set-cookie')).toStartWith('__Host-imp_session=');
});

test.each([
  ['another origin', { origin: 'http://evil.example' }],
  ['an imp’s port on the same host', { origin: 'http://imp:20001' }],
  ['the null origin', { origin: 'null' }],
  ['a same-site page', { 'sec-fetch-site': 'same-site' }],
  ['another site', { 'sec-fetch-site': 'cross-site' }],
  ['a navigation the user typed', { 'sec-fetch-site': 'none' }],
  [
    'another site that names impd’s origin',
    { 'sec-fetch-site': 'cross-site', origin: 'http://imp:7070' },
  ],
  ['no origin and no fetch site', {}],
])('#login refuses %s', async (_kind, headers) => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-secret' } }),
    }),
  );

  invariant(response);

  const body: unknown = await response.json();

  expect(response.status).toBe(403);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(body).toMatchObject({ json: { code: 'FORBIDDEN', message: 'cross-origin' } });
});

test('#login refuses a token that authenticates nobody', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'wrong' } }),
    }),
  );

  invariant(response);

  const body: unknown = await response.json();

  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(body).toMatchObject({ json: { defined: true, code: 'UNAUTHORIZED' } });
});

test('#login refuses a body without a token', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { secret: 'root-secret' } }),
    }),
  );

  invariant(response);

  expect(response.status).toBe(400);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('#login refuses a body that is not JSON', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/login', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{"json": {"token": "root-secret"',
    }),
  );

  invariant(response);

  expect(response.status).toBe(400);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('#login refuses a GET, which a link on any page can send', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });
  const data = encodeURIComponent(JSON.stringify({ json: { token: 'root-secret' } }));

  const response = await sessions.respond(
    new Request(`http://imp:7070/rpc/auth/login?data=${data}`, {
      headers: { 'sec-fetch-site': 'same-origin' },
    }),
  );

  invariant(response);

  expect(response.status).toBe(405);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('#logout clears the plain cookie over plain HTTP and reports the logout', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const onLogout = mock(() => {});

  const sessions = createSessionHandler({
    tokens,
    rootToken: 'root-secret',
    now: Date.now,
    onLogout,
  });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );

  invariant(response);

  expect(response.status).toBe(200);

  expect(
    response.headers.getSetCookie().map((header) => Bun.Cookie.parse(header).toJSON()),
  ).toStrictEqual([
    expect.objectContaining({
      name: 'imp_session',
      value: '',
      path: '/',
      maxAge: 0,
      httpOnly: true,
      sameSite: 'strict',
      secure: false,
    }),
  ]);

  expect(onLogout).toHaveBeenCalledOnce();
});

test('#logout clears both cookies over HTTPS', async () => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

  const response = await sessions.respond(
    new Request('https://imp.example.com/rpc/auth/logout', {
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );

  invariant(response);

  expect(
    response.headers.getSetCookie().map((header) => Bun.Cookie.parse(header).toJSON()),
  ).toStrictEqual([
    expect.objectContaining({ name: 'imp_session', value: '', maxAge: 0, secure: false }),
    expect.objectContaining({ name: '__Host-imp_session', value: '', maxAge: 0, secure: true }),
  ]);
});

test.each([
  ['another origin', { origin: 'http://evil.example' }],
  ['an imp’s port on the same host', { origin: 'http://imp:20001' }],
  ['the null origin', { origin: 'null' }],
  ['a same-site page', { 'sec-fetch-site': 'same-site' }],
  ['another site', { 'sec-fetch-site': 'cross-site' }],
  ['a navigation the user typed', { 'sec-fetch-site': 'none' }],
  ['no origin and no fetch site', {}],
])('#logout refuses %s, and reports no logout', async (_kind, headers) => {
  const ctx = await setupTest();
  const tokens = await ctx.loadTokens('root-secret');

  const onLogout = mock(() => {});

  const sessions = createSessionHandler({
    tokens,
    rootToken: 'root-secret',
    now: Date.now,
    onLogout,
  });

  const response = await sessions.respond(
    new Request('http://imp:7070/rpc/auth/logout', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
  );

  invariant(response);

  expect(response.status).toBe(403);
  expect(onLogout).not.toHaveBeenCalled();
});

test.each(['/rpc/auth/whoami', '/rpc/system/info', '/rpc/authors'])(
  '#respond leaves %s, outside the session contract, to the caller flow',
  async (path) => {
    const ctx = await setupTest();
    const tokens = await ctx.loadTokens('root-secret');

    const sessions = createSessionHandler({ tokens, rootToken: 'root-secret', now: Date.now });

    const answered = await sessions.respond(
      new Request(`http://imp:7070${path}`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
        body: '{}',
      }),
    );

    expect(answered).toBeNull();
  },
);
