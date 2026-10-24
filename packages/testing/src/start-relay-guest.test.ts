import { expect, onTestFinished, test } from 'bun:test';
import { once } from 'node:events';
import { openReverseForward } from '@impz/client';
import type { ReverseRelay } from '@impz/client';
import { waitFor } from '@impz/test-utils/wait-for';
import { startTestImpd } from './start-test-impd';

// Each case copies one behaviour of the Go agent's reverse forwards, in
// agent/internal/feature/listen/listen.go and agent/internal/feature/dial/dial.go (Relay).
async function setupTest() {
  const impd = await startTestImpd();

  onTestFinished(impd.stop);

  await impd.seedImage('ubuntu');

  const events: string[] = [];
  const relays: ReverseRelay[] = [];

  const createImp = async (name: string) => {
    await impd.client.imps.create({ name, image: 'ubuntu' });

    return impd.startGuest(name);
  };

  // the forward's local end: it records what reaches it, and answers each chunk with pong
  const openPortForward = (name: string, port: number) => {
    const forward = openReverseForward({
      baseUrl: impd.url,
      token: impd.token,
      name,
      guest: { network: 'tcp', port },
      connect: (url, headers) => new WebSocket(url, { headers: { ...headers } }),
      onConnection: (accept) => {
        const relay = accept({
          onData: (data) => {
            events.push(`data ${new TextDecoder().decode(data)}`);
            relay.send(new TextEncoder().encode('pong'));
          },
          onEof: () => {
            events.push('eof');
          },
          onClose: (lost) => {
            const outcome = lost ? 'lost' : 'closed';

            events.push(outcome);
          },
        });

        relays.push(relay);
      },
    });

    onTestFinished(forward.stop);

    return forward;
  };

  return { impd, events, relays, createImp, openPortForward };
}

// Accept pairs the CONNECTION with agent.accept, then Relay pumps both ways
test('it relays bytes from a process in the imp to the forward’s local end and back', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  await ctx.openPortForward('box', 4000).listening;

  const stream = await guest.connect(4000);

  const reply = Promise.withResolvers<string>();

  stream.once('data', (data: Uint8Array) => {
    reply.resolve(new TextDecoder().decode(data));
  });

  stream.write('ping');

  const chunk = await reply.promise;

  expect(chunk).toBe('pong');
  expect(ctx.events).toStrictEqual(['data ping']);
});

// pumpOut sends STDOUT_EOF when the process closes its side
test('it ends the local end’s input when the process in the imp ends its side', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  await ctx.openPortForward('box', 4000).listening;

  const stream = await guest.connect(4000);

  stream.end('last');

  await waitFor(() => {
    expect(ctx.events).toStrictEqual(['data last', 'eof']);
  });
});

// pumpIn half-closes the process's socket on STDIN_EOF, so the process reads to its end
test('it ends what the process in the imp reads when the local end sends its EOF', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  await ctx.openPortForward('box', 4000).listening;

  const stream = await guest.connect(4000);

  const ended = once(stream, 'end');

  stream.resume();
  stream.write('ping');

  await waitFor(() => {
    expect(ctx.relays.length).toBe(1);
  });

  ctx.relays[0]?.sendEof();

  await ended;

  expect(stream.readableEnded).toBeTrue();
});

// a read error ends Relay with no STDOUT_EOF, which the host sees as a reset
test('it drops the relay with no EOF when the process in the imp resets its connection', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  await ctx.openPortForward('box', 4000).listening;

  const stream = await guest.connect(4000);

  stream.write('ping');

  await waitFor(() => {
    expect(ctx.events).toStrictEqual(['data ping']);
  });

  stream.destroy();

  await waitFor(() => {
    expect(ctx.events.length).toBe(2);
  });

  expect(ctx.events).not.toContain('eof');
});

// serve ends the listener when the host's connection ends, as a vsock reset at a sleep does
test('it ends a forward when its imp sleeps, and listens again for a forward opened after the wake', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  const before = ctx.openPortForward('box', 4000);

  await before.listening;

  await ctx.impd.client.imps.sleep({ name: 'box' });

  const ended = await before.ended;

  const portsAsleep = guest.listPorts();

  await ctx.impd.client.imps.wake({ name: 'box' });
  await ctx.openPortForward('box', 4000).listening;

  const stream = await guest.connect(4000);

  const reply = Promise.withResolvers<string>();

  stream.once('data', (data: Uint8Array) => {
    reply.resolve(new TextDecoder().decode(data));
  });

  stream.write('ping');

  const chunk = await reply.promise;

  expect(ended).toStrictEqual({ kind: 'lost' });
  expect(portsAsleep).toStrictEqual([]);
  expect(chunk).toBe('pong');
});

// openBound reports the port the bind took, so port 0 comes back as a real port
test('it listens on a free port for a forward that asks for port 0', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');
  const listening = await ctx.openPortForward('box', 0).listening;

  // the stand-in's first free port, where the real agent takes one from the kernel
  expect(listening).toStrictEqual({ path: null, port: 32_768 });
  expect(guest.listPorts()).toStrictEqual([32_768]);
});

// bindTCP fails a second bind of a port with LISTEN_FAILED
test('it refuses a second forward on a port a forward already listens on', async () => {
  const ctx = await setupTest();

  await ctx.createImp('box');
  await ctx.openPortForward('box', 4000).listening;

  const second = ctx.openPortForward('box', 4000);

  expect(second.listening).rejects.toThrow('address already in use');
});

// serve names each listener with random hex, so two imps' listeners never share an ID
test('it relays the forwards of two imps on the same guest port apart', async () => {
  const ctx = await setupTest();
  const first = await ctx.createImp('one');
  const second = await ctx.createImp('two');

  await ctx.openPortForward('one', 4000).listening;
  await ctx.openPortForward('two', 4000).listening;

  const firstStream = await first.connect(4000);
  const secondStream = await second.connect(4000);

  const firstReply = Promise.withResolvers<string>();

  firstStream.once('data', (data: Uint8Array) => {
    firstReply.resolve(new TextDecoder().decode(data));
  });

  const secondReply = Promise.withResolvers<string>();

  secondStream.once('data', (data: Uint8Array) => {
    secondReply.resolve(new TextDecoder().decode(data));
  });

  firstStream.write('a');
  secondStream.write('b');

  const firstChunk = await firstReply.promise;
  const secondChunk = await secondReply.promise;

  expect(firstChunk).toBe('pong');
  expect(secondChunk).toBe('pong');
  expect(ctx.events.toSorted()).toStrictEqual(['data a', 'data b']);
});

test('it refuses a connection to a port no forward listens on', async () => {
  const ctx = await setupTest();
  const guest = await ctx.createImp('box');

  expect(guest.connect(4000)).rejects.toThrow('no reverse forward listens on port 4000');
});
