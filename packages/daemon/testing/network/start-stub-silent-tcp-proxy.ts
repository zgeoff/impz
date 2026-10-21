import { onTestFinished } from 'bun:test';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';

export async function startStubSilentTcpProxy(targetPort: number) {
  const link = { isSilent: false, dropped: 0, passedChunks: 0 };

  const sockets = new Set<Socket>();

  const registerSocket = (socket: Socket): void => {
    sockets.add(socket);

    socket.once('close', () => {
      sockets.delete(socket);
    });
  };

  const proxy = createServer((inbound) => {
    const outbound = createConnection({ host: '127.0.0.1', port: targetPort });

    registerSocket(inbound);
    registerSocket(outbound);

    inbound.on('data', (data: Buffer) => {
      if (link.isSilent) {
        link.dropped += data.length;

        return;
      }

      link.passedChunks += 1;

      outbound.write(data);
    });

    outbound.pipe(inbound);

    inbound.on('end', () => {
      outbound.end();
    });

    inbound.on('error', () => {
      outbound.destroy();
    });

    outbound.on('error', () => {
      inbound.destroy();
    });
  });

  await new Promise<void>((resolve) => {
    proxy.listen(0, '127.0.0.1', resolve);
  });

  onTestFinished(() => {
    for (const socket of sockets) {
      socket.destroy();
    }

    proxy.close();
  });

  const address = proxy.address();

  if (typeof address !== 'object' || address === null) {
    throw new TypeError('the proxy has no TCP address');
  }

  return {
    port: address.port,
    readDropped: (): number => link.dropped,
    readPassedChunks: (): number => link.passedChunks,

    silence: (): void => {
      link.isSilent = true;
    },
  };
}
