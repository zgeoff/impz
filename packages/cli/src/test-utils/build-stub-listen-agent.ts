import type { Socket } from 'node:net';
import {
  FRAME_TYPES,
  decodeJsonPayload,
  encodeFrame,
  encodeJsonFrame,
} from '@impz/daemon/src/vm/agent-client/frame-codec';
import type { StubAgentHandler } from '@impz/daemon/testing';
import * as z from 'zod';

const RequestSchema = z.looseObject({ op: z.string() });

interface AgentRefusal {
  readonly code: string;
  readonly message: string;
}

interface StubListenAgentOptions {
  readonly listening: Readonly<{ port: number }> | Readonly<{ path: string }>;
  readonly clientSends?: string;
}

export function buildStubListenAgent(options: Readonly<StubListenAgentOptions>) {
  const listens: Socket[] = [];
  const refusal: { error: AgentRefusal | null } = { error: null };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    if (frames.length > 1) {
      if (frames.at(-1)?.type === FRAME_TYPES.stdinEof) {
        socket.end(encodeFrame(FRAME_TYPES.stdoutEof));
      }

      return;
    }

    const op = RequestSchema.parse(decodeJsonPayload(request)).op;

    if (op === 'listen' && refusal.error !== null) {
      socket.end(encodeJsonFrame(FRAME_TYPES.response, { error: refusal.error }));
    } else if (op === 'listen') {
      listens.push(socket);

      const id = listens.length;

      socket.write(
        encodeJsonFrame(FRAME_TYPES.response, {
          ok: true,
          listener: `fwd${String(id)}`,
          ...options.listening,
        }),
      );

      if (options.clientSends !== undefined) {
        socket.write(encodeJsonFrame(FRAME_TYPES.connection, { id }));
      }
    } else if (op === 'agent.accept') {
      socket.write(encodeJsonFrame(FRAME_TYPES.response, { ok: true }));
      socket.write(encodeFrame(FRAME_TYPES.stdout, new TextEncoder().encode(options.clientSends)));
    } else {
      socket.end();
    }
  };

  return {
    readFrame,
    listens,
    refuseListens: (error: AgentRefusal) => {
      refusal.error = error;
    },
  };
}
