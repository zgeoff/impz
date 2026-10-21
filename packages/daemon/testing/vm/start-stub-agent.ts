import { onTestFinished } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { dirname } from 'node:path';
import { buildFrameDecoder } from '@impz/agent-protocol';
import type { AgentFrame } from '@impz/agent-protocol';

export type StubAgentHandler = (
  socket: Socket,
  request: AgentFrame,
  frames: readonly AgentFrame[],
) => void;

export async function startStubAgent(
  path: string,
  agent: StubAgentHandler,
  options: Readonly<{ stack?: Readonly<AsyncDisposableStack> }> = {},
) {
  const received: AgentFrame[] = [];
  const counts = { reads: 0 };

  mkdirSync(dirname(path), { recursive: true });

  const server = createServer((socket) => {
    const decoder = buildFrameDecoder();
    const frames: AgentFrame[] = [];

    let pending: Uint8Array | null = new Uint8Array();

    socket.on('data', (chunk: Uint8Array) => {
      counts.reads += 1;

      let bytes = chunk;

      if (pending !== null) {
        const line = Buffer.concat([pending, chunk]);
        const newline = line.indexOf(10);

        if (newline === -1) {
          pending = line;

          return;
        }

        pending = null;

        socket.write('OK 1073741824\n');

        bytes = line.subarray(newline + 1);
      }

      for (const frame of decoder.push(bytes)) {
        received.push(frame);
        frames.push(frame);

        agent(socket, frames[0] ?? frame, frames);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(path, resolve);
  });

  const stopServer = (): void => {
    server.close();
  };

  if (options.stack === undefined) {
    onTestFinished(stopServer);
  } else {
    options.stack.defer(stopServer);
  }

  return {
    received,
    get reads(): number {
      return counts.reads;
    },
    close: stopServer,
  };
}
