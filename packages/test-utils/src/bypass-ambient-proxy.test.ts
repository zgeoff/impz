import { expect, onTestFinished, test } from 'bun:test';
import { bypassAmbientProxy } from './bypass-ambient-proxy';
import { updateEnv } from './update-env';

test('it sends a fetch straight to the server when the shell names a proxy', async () => {
  updateEnv('NO_PROXY', '');
  updateEnv('no_proxy', '');
  updateEnv('HTTP_PROXY', 'http://127.0.0.1:9');
  bypassAmbientProxy();

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.2',
    routes: { '/': new Response('direct') },
  });

  onTestFinished(() => server.stop(true));

  const response = await fetch(`http://127.0.0.2:${String(server.port)}/`);
  const text = await response.text();

  expect(text).toBe('direct');
});
