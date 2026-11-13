import { expect, mock, onTestFinished, test } from 'bun:test';
import {
  buildPkceChallenge,
  buildRouteOrigin,
  parseEnrollmentToken,
  parseMcpBody,
  parsePasskeyPage,
  readCookies,
  sendMcp,
} from './oauth-route';

test('#buildRouteOrigin publishes the route at the instance’s port offset', () => {
  expect(buildRouteOrigin({ portOffset: 700 })).toBe('http://127.0.0.1:7771');
});

test('#buildPkceChallenge gives RFC 7636 appendix B challenge', () => {
  expect(buildPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
});

test('#parsePasskeyPage reads the sign-in options a login page hands the browser', () => {
  const page = [
    '<form method="post" action="/login"></form>',
    '<script type="application/json" id="mcp-auth-passkey">',
    '{"mode":"get","options":{"challenge":"Y2hhbA","rpId":"imp.example"}}',
    '</script>',
  ].join('');

  expect(parsePasskeyPage(page)).toStrictEqual({
    mode: 'get',
    options: { challenge: 'Y2hhbA', rpId: 'imp.example' },
  });
});

test('#parsePasskeyPage reads a page with no passkey block as null', () => {
  expect(parsePasskeyPage('<p>expired</p>')).toBeNull();
});

test.each([
  ['token: abc_123-x\nopen https://imp.example/enroll\n', 'abc_123-x'],
  ['no token here\n', ''],
])('#parseEnrollmentToken reads %p as %p', (stdout, token) => {
  expect(parseEnrollmentToken(stdout)).toBe(token);
});

test('#readCookies sends back each cookie a response sets, without its attributes', () => {
  const headers = new Headers();

  headers.append('set-cookie', 'session=abc; Path=/; HttpOnly');
  headers.append('set-cookie', 'data=xyz; Max-Age=60');

  expect(readCookies(new Response(null, { headers }))).toBe('session=abc; data=xyz');
});

test('#parseMcpBody reads the last event of a stream', () => {
  const text = [
    'event: message',
    'data: {"jsonrpc":"2.0","method":"notifications/progress"}',
    '',
    ': keepalive',
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{}}',
    '',
  ].join('\n');

  expect(parseMcpBody(text)).toStrictEqual({ jsonrpc: '2.0', id: 1, result: {} });
});

test('#parseMcpBody reads a JSON body', () => {
  expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toStrictEqual({
    jsonrpc: '2.0',
    id: 1,
    result: {},
  });
});

test('#parseMcpBody reads a body that is not JSON as its text', () => {
  expect(parseMcpBody('Unauthorized')).toBe('Unauthorized');
});

test('#sendMcp sends explicit null params as null', async () => {
  const received = mock();

  const mcp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: {
      '/mcp': {
        POST: async (request) => {
          const body: unknown = await request.json();

          received(body);

          return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
        },
      },
    },
  });

  onTestFinished(() => mcp.stop(true));

  await sendMcp({
    origin: `http://127.0.0.1:${mcp.port}`,
    bearer: 'route-token',
    session: '',
    method: 'tools/list',
    params: null,
  });

  expect(received).toHaveBeenCalledExactlyOnceWith({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: null,
  });
});

test('#sendMcp sends empty params when none are given', async () => {
  const received = mock();

  const mcp = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: {
      '/mcp': {
        POST: async (request) => {
          const body: unknown = await request.json();

          received(body);

          return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
        },
      },
    },
  });

  onTestFinished(() => mcp.stop(true));

  await sendMcp({
    origin: `http://127.0.0.1:${mcp.port}`,
    bearer: 'route-token',
    session: '',
    method: 'tools/list',
  });

  expect(received).toHaveBeenCalledExactlyOnceWith({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });
});
