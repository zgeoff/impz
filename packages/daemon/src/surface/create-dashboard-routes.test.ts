import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImpContract } from '@impz/api';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { ContractRouterClient } from '@orpc/contract';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../testing/imps/build-mock-new-image';
import { startTestImpd } from '../../testing/start-test-impd';
import { tryExecSocket } from '../../testing/surface/try-impd-sockets';
import { createImage } from '../platform/db/images';
import { buildImagePaths } from '../vm/storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dashboardDir = await mkdtemp(join(tmpdir(), 'impd-dashboard-'));

  stack.defer(() => rm(dashboardDir, { recursive: true, force: true }));

  await mkdir(join(dashboardDir, 'assets'), { recursive: true });

  const harness = await startTestImpd(stack, {
    env: { IMP_DASHBOARD_DIR: dashboardDir },
    rootToken: 'root-token',
  });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  return {
    dashboardDir,
    port: new URL(harness.url).port,
    sendToImpd: (request: Request) => harness.impd.api.app.handle(request),
  };
}

test('it answers a login with the token with a strict session cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie')).toStartWith('imp_session=v2.root.');
  expect(login.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict');
});

test('it accepts the session from its own page', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const sendBrowserRequest = (request: Request) => ctx.sendToImpd(request);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie,
        'sec-fetch-site': 'same-origin',
      },
      fetch: sendBrowserRequest,
    }),
  );

  const imps = await browser.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it answers a login behind TLS with a secure __Host- session cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: {
        origin: 'http://impd.test',
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  expect(login.headers.get('set-cookie')).toStartWith('__Host-imp_session=v2.root.');
  expect(login.headers.get('set-cookie')).toInclude('; Secure;');
});

test('it accepts the __Host- session from its own page', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: {
        origin: 'http://impd.test',
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const sendBrowserRequest = (request: Request) => ctx.sendToImpd(request);

  const browser: ContractRouterClient<ImpContract> = createORPCClient(
    new RPCLink({
      url: 'http://impd.test/rpc',
      headers: {
        cookie,
        'sec-fetch-site': 'same-origin',
      },
      fetch: sendBrowserRequest,
    }),
  );

  const imps = await browser.imps.list();

  expect(imps).toStrictEqual([]);
});

test('it clears both cookie names at a logout behind TLS', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'x-forwarded-proto': 'https' },
    }),
  );

  expect(logout.headers.getSetCookie().map((cookie) => cookie.split(';')[0])).toStrictEqual([
    'imp_session=',
    '__Host-imp_session=',
  ]);
});

test('it refuses a login with the wrong token and sets no cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'wrong' } }),
    }),
  );

  expect(login.status).toBe(401);
  expect(login.headers.get('set-cookie')).toBeNull();
});

test('it refuses a login from another origin and sets no cookie', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test:20001', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  expect(login.status).toBe(403);
  expect(login.headers.get('set-cookie')).toBeNull();
});

test.each([
  ['a link', {}],
  ['a same-site link', { 'sec-fetch-site': 'same-site' }],
])('it refuses %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'GET',
      headers: { ...headers, cookie },
    }),
  );

  expect(response.status).toBe(401);
});

test.each([
  ['from another origin', { origin: 'http://impd.test:20001' }],
  ['with no origin', {}],
])('it refuses a form post %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'POST',
      headers: { ...headers, cookie },
      body: new FormData(),
    }),
  );

  expect(response.status).toBe(401);
});

test.each([
  ['from another origin', { origin: 'http://impd.test:20001' }],
  ['with no origin', {}],
])('it refuses a text/plain fetch %s that carries only the session', async (_label, headers) => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain', cookie },
      body: '{"json":{}}',
    }),
  );

  expect(response.status).toBe(401);
});

test('it refuses an API GET even with the token', async () => {
  const ctx = await setupTest();

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list?data=%7B%22json%22%3A%7B%7D%7D', {
      headers: { authorization: 'Bearer root-token' },
    }),
  );

  expect(response.status).toBe(405);
});

test('it refuses a logout from another origin', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test:20001' },
    }),
  );

  expect(logout.status).toBe(403);
});

test('it clears the cookie at a logout from its own origin', async () => {
  const ctx = await setupTest();

  const logout = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/logout', {
      method: 'POST',
      headers: { origin: 'http://impd.test' },
    }),
  );

  expect(logout.status).toBe(200);
  expect(logout.headers.get('set-cookie')).toStartWith('imp_session=; Max-Age=0; Path=/');
});

test('it refuses an /exec socket that carries only the session', async () => {
  const ctx = await setupTest();

  const login = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/auth/login', {
      method: 'POST',
      headers: { origin: 'http://impd.test', 'content-type': 'application/json' },
      body: JSON.stringify({ json: { token: 'root-token' } }),
    }),
  );

  const cookie = login.headers.get('set-cookie')?.split(';')[0];

  invariant(cookie !== undefined);

  const outcome = await tryExecSocket(ctx.port, '', 'dev', {
    cookie,
    origin: `http://127.0.0.1:${ctx.port}`,
  });

  expect(outcome).toBe('rejected');
});

test('it redirects the root to the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/'));

  expect(response.headers.get('location')).toBe('/ui/');
});

test('it answers a dashboard app route with the shell', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/ui/imps/box'));
  const body = await response.text();

  expect(body).toBe('<!doctype html><title>imp</title>');
});

test('it answers /health beside the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(new Request('http://impd.test/health'));
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ status: 'ok', ready: true, warnings: expect.toBeArray() });
});

test('it keeps the API behind its auth beside the dashboard', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.dashboardDir, 'index.html'), '<!doctype html><title>imp</title>');

  const response = await ctx.sendToImpd(
    new Request('http://impd.test/rpc/imps/list', { method: 'POST' }),
  );

  expect(response.status).toBe(401);
});
