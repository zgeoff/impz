import { createConnection } from 'node:net';

interface StubGuestSocketOptions {
  readonly port: number;
  readonly address: string;
}

export async function startStubBrokerGuestSocket(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubGuestSocketOptions>,
) {
  const connected = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];

  const socket = createConnection(
    { host: '127.0.0.1', port: options.port, localAddress: options.address },
    () => {
      connected.resolve();
    },
  );

  stack.defer(() => {
    socket.destroy();
  });

  socket.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  socket.on('error', (error) => {
    connected.reject(error);
  });

  socket.once('close', () => {
    reply.resolve(Buffer.concat(chunks).toString());
  });

  await connected.promise;

  return {
    reply: reply.promise,
    write: (text: string): void => {
      socket.write(text);
    },
  };
}
