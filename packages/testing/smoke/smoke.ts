import { expect, onTestFinished, test } from 'bun:test';
import { once } from 'node:events';
import { openReverseForward } from '@impz/client';
import { TEST_TOKEN, startTestImpd } from '@impz/testing';

// The installed package as a user's test runs it: impd starts, a reverse forward relays a process
// in the imp to its local end, and the forward ends and reopens across a sleep and a wake.
test('it relays a process in an imp through a reverse forward across a sleep and a wake', async () => {
  const impd = await startTestImpd();

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');
  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

  const guest = await impd.startGuest('box');

  const openForward = () => {
    const forward = openReverseForward({
      baseUrl: impd.url,
      token: TEST_TOKEN,
      name: 'box',
      guest: { network: 'tcp', port: 4000 },
      connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
      onConnection: (accept) => {
        const relay = accept({
          onData: () => {
            relay.send(new TextEncoder().encode('pong'));
          },
          onEof: () => {
            relay.sendEof();
          },
          onClose: () => {},
        });
      },
    });

    onTestFinished(forward.stop);

    return forward;
  };

  const before = openForward();

  await before.listening;

  await impd.client.imps.sleep({ name: 'box' });

  const ended = await before.ended;

  await impd.client.imps.wake({ name: 'box' });

  await openForward().listening;

  const stream = await guest.connect(4000);

  const reply = once(stream, 'data');

  stream.write('ping');

  const [chunk] = await reply;

  expect(ended).toStrictEqual({ kind: 'lost' });
  expect(String(chunk)).toBe('pong');
});
