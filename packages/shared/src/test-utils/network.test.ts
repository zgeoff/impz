import { expect, test } from 'bun:test';
import { HttpResponse, http } from 'msw';
import { network } from './network';

test('it answers a request with a handler the test adds', async () => {
  network.use(http.get('https://registry.example.test/v2/', () => HttpResponse.json({ ok: true })));

  const response = await fetch('https://registry.example.test/v2/');
  const body: unknown = await response.json();

  expect(body).toStrictEqual({ ok: true });
});

test('it sends a request to a loopback stub server on, with no handler', async () => {
  using stub = Bun.serve({ port: 0, hostname: '127.0.0.1', routes: { '/': new Response('stub') } });

  const response = await fetch(`http://127.0.0.1:${String(stub.port)}/`);
  const body = await response.text();

  expect(body).toBe('stub');
});
