import { createConnection } from 'node:net';

interface StubTunnelOptions {
  readonly proxyPort: number;
  readonly address: string;
  readonly target: string;
}

export async function startStubBrokerTunnel(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubTunnelOptions>,
) {
  const established = Promise.withResolvers<void>();
  const connected = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const state = { open: true };

  const socket = createConnection(
    { host: '127.0.0.1', port: options.proxyPort, localAddress: options.address },
    () => {
      connected.resolve();
    },
  );

  stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    const text = chunk.toString();

    if (text.startsWith('HTTP/1.1 200')) {
      established.resolve();
    } else {
      established.reject(new Error(text));
    }
  });

  socket.on('error', (error) => {
    connected.reject(error);
  });

  socket.once('close', () => {
    state.open = false;

    closed.resolve();
  });

  await connected.promise;

  return {
    established: established.promise,
    closed: closed.promise,
    sendHead: (): void => {
      socket.write(`CONNECT ${options.target} HTTP/1.1\r\nHost: ${options.target}\r\n\r\n`);
    },
    isOpen: () => state.open,
  };
}
