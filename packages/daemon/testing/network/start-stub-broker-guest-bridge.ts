import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { updateEnv } from '@impz/test-utils/update-env';

interface StubGuestBridgeOptions {
  readonly proxyPort: number;
  readonly address: string;
}

// A client such as Bun's WebSocket cannot pick its source address, which the
// broker names the imp by, so it reaches the broker through this bridge.
export async function startStubBrokerGuestBridge(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubGuestBridgeOptions>,
) {
  // Bun's WebSocket skips even a `proxy` it is given for a host NO_PROXY
  // matches, and the test preload's matches every host; loopback stays direct
  updateEnv('NO_PROXY', 'localhost,127.0.0.1');
  updateEnv('no_proxy', 'localhost,127.0.0.1');

  const open = new Set<Socket>();

  const server = createServer((socket) => {
    const out = createConnection({
      host: '127.0.0.1',
      port: options.proxyPort,
      localAddress: options.address,
    });

    for (const end of [socket, out]) {
      open.add(end);
      end.on('error', () => {});

      end.once('close', () => {
        open.delete(end);
        socket.destroy();
        out.destroy();
      });
    }

    socket.pipe(out);
    out.pipe(socket);
  });

  const listening = Promise.withResolvers<void>();

  server.listen(0, '127.0.0.1', () => {
    listening.resolve();
  });

  await listening.promise;

  stack.defer(async () => {
    for (const socket of open) {
      socket.destroy();
    }

    const closed = Promise.withResolvers<void>();

    server.close(() => {
      closed.resolve();
    });

    await closed.promise;
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return { proxyURL: `http://127.0.0.1:${String(port)}` };
}
