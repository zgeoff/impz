import { expect, onTestFinished, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
import { startTestImpd } from '../testing/start-test-impd';

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
  ['the image build', 'POST', '/images/build', '127.0.0.1:7171'],
  ['a move step', 'POST', '/move/prepare', '127.0.0.1:7171'],
  ['an imp’s wake route', 'GET', '/', 'dev.imp.example'],
  ['an imp’s wake route', 'GET', '/mcp', 'dev.imp.example'],
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
