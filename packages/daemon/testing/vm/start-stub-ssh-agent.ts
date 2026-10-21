import { onTestFinished } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface StubSshAgentOptions {
  readonly mode: 'answer' | 'hold';
}

export async function startStubSshAgent(options: Readonly<StubSshAgentOptions>) {
  const directory = await mkdtemp(join(tmpdir(), 'imp-agent-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  const path = join(directory, 'agent.sock');

  const sockets = new Set<Socket>();

  const server = createServer((socket) => {
    sockets.add(socket);

    socket.once('close', () => {
      sockets.delete(socket);
    });

    if (options.mode === 'answer') {
      socket.on('data', (data: Buffer) => {
        socket.write(`agent:${data.toString()}`);
      });
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  // A server's close waits for its open connections, so each held one ends first.
  onTestFinished(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });

        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  );

  return { path };
}
