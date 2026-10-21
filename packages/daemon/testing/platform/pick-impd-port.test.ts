import { expect, onTestFinished, test } from 'bun:test';
import { pickImpdPort } from './pick-impd-port';

test.each([
  [0, 10_100],
  [0.008, 10_179],
  [0.9999, 19_999],
])('it picks port %d for a draw of %d', (draw, port) => {
  expect(pickImpdPort(draw)).toBe(port);
});

test('it picks a port that fetch reaches for the draw that once gave 10080', async () => {
  const server = Bun.serve({ port: pickImpdPort(0.008), routes: { '/': new Response('pong') } });

  onTestFinished(() => server.stop(true));

  const response = await fetch(`http://127.0.0.1:${String(server.port)}/`);
  const body = await response.text();

  expect(body).toBe('pong');
});
