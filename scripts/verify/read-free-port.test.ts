import { expect, onTestFinished, test } from 'bun:test';
import { readFreePort } from './read-free-port.ts';

test('it returns a port below the imps slot ports that a listener can bind', () => {
  const port = readFreePort();
  const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });

  onTestFinished(() => {
    listener.stop(true);
  });

  expect(port).toBeWithin(10_000, 20_000);
});
