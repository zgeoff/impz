import { expect, onTestFinished, test } from 'bun:test';
import { removeAmbientProxyEnv } from './remove-ambient-proxy-env';
import { updateEnv } from './update-env';

test.each([
  ['HTTP_PROXY'],
  ['HTTPS_PROXY'],
  ['ALL_PROXY'],
  ['http_proxy'],
  ['https_proxy'],
  ['all_proxy'],
])('it empties the proxy variable %s', (key) => {
  updateEnv(key, 'http://10.0.0.9:3128');
  removeAmbientProxyEnv();

  expect(process.env[key]).toBe('');
});

test('it keeps NO_PROXY', () => {
  updateEnv('NO_PROXY', 'localhost');
  removeAmbientProxyEnv();

  expect(process.env['NO_PROXY']).toBe('localhost');
});

test('it sends a fetch past the proxy that the shell set', async () => {
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    routes: { '/*': new Response('the proxy', { status: 502 }) },
  });

  onTestFinished(() => proxy.stop(true));

  const origin = Bun.serve({
    hostname: '127.0.0.2',
    port: 0,
    routes: { '/*': new Response('the origin') },
  });

  onTestFinished(() => origin.stop(true));
  updateEnv('NO_PROXY', '');
  updateEnv('no_proxy', '');
  updateEnv('HTTP_PROXY', proxy.url.href);
  updateEnv('http_proxy', proxy.url.href);
  removeAmbientProxyEnv();

  const response = await fetch(origin.url);
  const body = await response.text();

  expect(body).toBe('the origin');
});
