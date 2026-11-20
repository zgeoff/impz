import { expect, onTestFinished, test } from 'bun:test';
import type { Duplex } from 'node:stream';
import { openReverseForward } from '@impz/client';
import { loadIdentityIssuers, verifyImpIdentity } from '@impz/client/identity';
import { TEST_TOKEN, startTestImpd } from '@impz/testing';
import { createTestIdentityIssuer } from '@impz/testing/identity';

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

  const reply = readChunk(stream);

  stream.write('ping');

  const chunk = await reply;

  expect(ended).toStrictEqual({ kind: 'lost' });
  expect(chunk).toBe('pong');
});

// the next chunk the stream reads, as text
function readChunk(stream: Duplex): Promise<string> {
  const chunk = Promise.withResolvers<string>();

  stream.once('data', (data: Uint8Array) => {
    chunk.resolve(new TextDecoder().decode(data));
  });

  return chunk.promise;
}

// A fault answers in place of impd, and the next call reaches it.
test('it refuses one call with a fault and answers the next', async () => {
  const impd = await startTestImpd();

  onTestFinished(impd.stop);

  impd.fail('imps/list', { code: 'CONFLICT', status: 409 }, { times: 1 });

  await expect(impd.client.imps.list()).rejects.toMatchObject({ code: 'CONFLICT', status: 409 });

  const imps = await impd.client.imps.list();

  expect(imps).toStrictEqual([]);
});

// The test issuer needs no impd, and the client's verifier accepts its token.
test('it signs an identity token that the client verifies', async () => {
  const issuer = await createTestIdentityIssuer({ issuer: 'host-a' });

  const token = await issuer.signToken({
    id: 'imp-1',
    name: 'box',
    audience: 'tasks.imp.internal',
    nowSeconds: 1000,
  });

  const verified = await verifyImpIdentity(token, {
    issuers: loadIdentityIssuers([issuer.document]),
    audience: 'tasks.imp.internal',
    nowSeconds: 1010,
  });

  expect(verified).toStrictEqual({ issuer: 'host-a', id: 'imp-1', name: 'box' });
});
