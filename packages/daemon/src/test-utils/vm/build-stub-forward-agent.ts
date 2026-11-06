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
import type { Request } from '@impz/agent-protocol';
import type { StubAgentHandler } from './start-stub-agent';

interface AgentRefusal {
  readonly code: string;
  readonly message: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function buildStubForwardAgent() {
  const requests: Request[] = [];
  const listeners: Socket[] = [];
  const refusal: { error: AgentRefusal | null } = { error: null };

  const readFrame: StubAgentHandler = (socket, request, frames) => {
    if (frames.length > 1) {
      const frame = frames.at(-1);

      if (frame?.type === FRAME_TYPES.stdin) {
        const reply = encoder.encode(`got ${decoder.decode(frame.payload)}`);

        socket.write(encodeFrame(FRAME_TYPES.stdout, reply));
        socket.write(encodeFrame(FRAME_TYPES.stdoutEof));
      }

      if (frame?.type === FRAME_TYPES.stdinEof) {
        socket.end();
      }

      return;
    }

    const parsed = decodeMessageFrame(RequestSchema, request);

    requests.push(parsed);
    socket.on('error', () => {});

    if (parsed.op === 'listen' && refusal.error !== null) {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, { error: refusal.error }),
      );
    } else if (parsed.op === 'listen') {
      listeners.push(socket);

      socket.write(
        encodeMessageFrame(FRAME_TYPES.response, ListeningSchema, {
          ok: true,
          listener: `fwd${String(listeners.length)}`,
          ...readListening(parsed),
        }),
      );
    } else if (parsed.op === 'agent.accept') {
      socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    } else {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
          error: { code: 'UNKNOWN_OP', message: `unknown op ${parsed.op}` },
        }),
      );
    }
  };

  return {
    requests,
    readFrame,
    connect: (id: number) => {
      listeners.at(-1)?.write(encodeMessageFrame(FRAME_TYPES.connection, ConnectionSchema, { id }));
    },
    endListeners: () => {
      for (const listener of listeners) {
        listener.end();
      }
    },
    refuseListens: (error: AgentRefusal) => {
      refusal.error = error;
    },
  };
}

function readListening(request: Readonly<Request>) {
  if (request.network === 'tcp') {
    return { port: 4000 };
  }

  return { path: request.address === '' ? '/run/imp/forward/1.sock' : request.address };
}
