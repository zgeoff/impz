import type { Socket } from 'node:net';
import {
  ConnectionSchema,
  ErrorResponseSchema,
  FRAME_TYPES,
  ListeningSchema,
  OKSchema,
  RequestSchema,
  decodeMessageFrame,
  encodeFrame,
  encodeMessageFrame,
} from '@impz/agent-protocol';
import type { StubAgentHandler } from '@impz/daemon/testing';

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

    const op = decodeMessageFrame(RequestSchema, request).op;

    if (op === 'listen' && refusal.error !== null) {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, { error: refusal.error }),
      );
    } else if (op === 'listen') {
      listens.push(socket);

      const id = listens.length;

      socket.write(
        encodeMessageFrame(FRAME_TYPES.response, ListeningSchema, {
          ok: true,
          listener: `fwd${String(id)}`,
          ...options.listening,
        }),
      );

      if (options.clientSends !== undefined) {
        socket.write(encodeMessageFrame(FRAME_TYPES.connection, ConnectionSchema, { id }));
      }
    } else if (op === 'agent.accept') {
      socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
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
