import { expect, test } from 'bun:test';
import { pickImpdPort } from './pick-impd-port';

test.each([
  [0, 10_100],
  [0.008, 10_179],
  [0.9999, 19_999],
])('it picks port %d for a draw of %d', (draw, port) => {
  expect(pickImpdPort(draw)).toBe(port);
});

// Bun's fetch dials any port; Node's refuses the fetch spec's bad ports, 10080 among them
test('it picks a port that node dials for the draw that once gave 10080', async () => {
  const url = `http://127.0.0.1:${String(pickImpdPort(0.008))}/`;

  const child = Bun.spawn(
    [
      'node',
      '-e',
      `fetch(${JSON.stringify(url)}).then(() => console.log('ok'), (error) => console.log(error.cause?.code ?? error.cause?.message))`,
    ],
    { stdout: 'pipe' },
  );

  const output = await new Response(child.stdout).text();

  expect(output.trim()).toBeOneOf(['ok', 'ECONNREFUSED']);
});
