import { onTestFinished } from 'bun:test';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';

interface StubSilentBuildEngineOptions {
  readonly socketPath: string;
  readonly imageId: string;
  readonly holdUntil: () => Promise<void>;
}

// a raw socket server, so no Bun server idle limit ends the engine's silence
export async function startStubSilentBuildEngine(options: StubSilentBuildEngineOptions) {
  const sockets = new Set<Socket>();

  const firstClose = Promise.withResolvers<void>();
  const firstRequest = Promise.withResolvers<void>();

  const engine = createServer((socket) => {
    sockets.add(socket);

    socket.on('close', () => {
      sockets.delete(socket);
      firstClose.resolve();
    });

    socket.on('error', () => {});

    socket.once('data', () => {
      firstRequest.resolve();
      void sendBuildAnswer(socket, options);
    });
  });

  await new Promise<void>((resolve) => {
    engine.listen(options.socketPath, resolve);
  });

  const stopping: { done: Promise<void> | null } = { done: null };

  const stop = (): Promise<void> => {
    stopping.done ??= new Promise<void>((resolve) => {
      for (const socket of sockets) {
        socket.destroy();
      }

      engine.close(() => {
        resolve();
      });
    });

    return stopping.done;
  };

  onTestFinished(stop);

  return {
    closed: firstClose.promise,
    started: firstRequest.promise,
    stop,
  };
}

async function sendBuildAnswer(
  socket: Socket,
  options: StubSilentBuildEngineOptions,
): Promise<void> {
  socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n');
  socket.write('Transfer-Encoding: chunked\r\n\r\n');
  socket.write(toChunk({ id: 'moby.buildkit.trace', aux: 'CgQ=' }));

  await options.holdUntil();

  socket.end(`${toChunk({ id: 'moby.image.id', aux: { ID: options.imageId } })}0\r\n\r\n`);
}

function toChunk(line: unknown): string {
  const text = `${JSON.stringify(line)}\n`;

  return `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n`;
}
