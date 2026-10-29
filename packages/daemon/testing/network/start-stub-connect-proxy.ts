import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';

interface StubConnectProxyOptions {
  readonly targetPort: number;
}

// An HTTP proxy that answers each CONNECT with 200, whatever it names, and
// then pipes the connection to one local port.
export async function startStubConnectProxy(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubConnectProxyOptions>,
) {
  const connects: string[] = [];

  const open = new Set<Socket>();

  const server = createServer((socket) => {
    open.add(socket);
    socket.on('error', () => {});

    socket.once('close', () => {
      open.delete(socket);
    });

    socket.once('data', (head: Buffer) => {
      connects.push(head.toString('latin1').split('\r\n')[0] ?? '');

      const out = createConnection({ host: '127.0.0.1', port: options.targetPort }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.pipe(out);
        out.pipe(socket);
      });

      open.add(out);
      out.on('error', () => {});

      out.once('close', () => {
        open.delete(out);
        socket.destroy();
      });
    });
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

  return { port, connects };
}
