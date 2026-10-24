import { expect, onTestFinished, test } from 'bun:test';
import { once } from 'node:events';
import { openReverseForward } from '@impz/client';
import { startTestImpd } from './start-test-impd';

async function setupTest() {
  const impd = await startTestImpd();

  const received: string[] = [];

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');
  await impd.client.imps.create({ name: 'box', image: 'ubuntu' });

  // the forward's local end: it records what the process in the imp sends, and answers pong
  const openPortForward = (port: number) => {
    const forward = openReverseForward({
      baseUrl: impd.url,
      token: impd.token,
      name: 'box',
      guest: { network: 'tcp', port },
      connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
      onConnection: (accept) => {
        const relay = accept({
          onData: (data) => {
            received.push(new TextDecoder().decode(data));
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

  return { impd, received, openPortForward };
}

test('it serves impd at its url to a client that holds its token', async () => {
  const ctx = await setupTest();
  const response = await fetch(`${ctx.impd.url}/health`);
  const imps = await ctx.impd.client.imps.list();

  expect(response.status).toBe(200);
  expect(imps.map((imp) => imp.name)).toStrictEqual(['box']);
});

test('it relays a process in the imp through a reverse forward to the forward’s local end', async () => {
  const ctx = await setupTest();
  const guest = await ctx.impd.startGuest('box');

  const forward = ctx.openPortForward(4000);

  const listening = await forward.listening;
  const stream = await guest.connect(4000);

  const reply = once(stream, 'data');

  stream.write('ping');

  const [chunk] = await reply;

  expect(listening).toStrictEqual({ path: null, port: 4000 });
  expect(String(chunk)).toBe('pong');
  expect(ctx.received).toStrictEqual(['ping']);
});

test('it ends a forward when its imp sleeps, and relays through one opened after the wake', async () => {
  const ctx = await setupTest();
  const guest = await ctx.impd.startGuest('box');

  const before = ctx.openPortForward(4000);

  await before.listening;

  await ctx.impd.client.imps.sleep({ name: 'box' });

  const ended = await before.ended;

  const portsAsleep = guest.listPorts();

  await ctx.impd.client.imps.wake({ name: 'box' });

  const after = ctx.openPortForward(4000);

  await after.listening;

  const stream = await guest.connect(4000);

  const reply = once(stream, 'data');

  stream.write('ping');

  const [chunk] = await reply;

  expect(ended).toStrictEqual({ kind: 'lost' });
  expect(portsAsleep).toStrictEqual([]);
  expect(String(chunk)).toBe('pong');
});

test('it refuses a connection to a port no forward listens on', async () => {
  const ctx = await setupTest();
  const guest = await ctx.impd.startGuest('box');

  await expect(guest.connect(4000)).rejects.toThrow('no reverse forward listens on port 4000');
});

test('it fails to fire a ticker that impd does not wait on', async () => {
  const ctx = await setupTest();

  await expect(ctx.impd.fireTicker('no-such-ticker')).rejects.toThrow(
    'nothing waits on a timer named no-such-ticker',
  );
});

test('it stops impd, which then answers no request', async () => {
  const impd = await startTestImpd();

  const url = impd.url;

  await impd.stop();

  await expect(fetch(`${url}/health`)).rejects.toThrow();
});
