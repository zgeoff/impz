import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
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
import type { AgentFrame, Request } from '@impz/agent-protocol';
import { startStubAgent } from '@impz/daemon/testing/start-stub-agent';
import type { TestGuest } from './types';

export interface RelayGuest {
  readonly guest: TestGuest;
  readonly endConnections: () => void;
}

interface GuestListener {
  readonly socket: Socket;
  readonly id: string;
  readonly port: number;
  readonly pending: Map<number, PromiseWithResolvers<Duplex>>;
  readonly counts: { next: number };
}

// The guest agent's reverse-forward side, after agent/internal/feature/listen and dial.Relay: it
// listens where impd asks, and `connect` plays a process in the imp that dials the guest port.
// `endConnections` drops every agent connection, as a VM that stops does.
export async function startRelayGuest(
  stack: Readonly<AsyncDisposableStack>,
  vsockPath: string,
): Promise<RelayGuest> {
  const listeners = new Map<string, GuestListener>();
  const ports = new Map<number, GuestListener>();
  const streams = new Map<Socket, Duplex>();

  const openListener = (socket: Socket, request: Readonly<Request>): void => {
    const asked = Number(request.address?.split(':').at(-1));
    const port = asked === 0 ? pickFreePort(ports) : asked;

    if (ports.has(port)) {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
          error: {
            code: 'LISTEN_FAILED',
            message: `listen on ${request.address ?? ''}: address already in use`,
          },
        }),
      );

      return;
    }

    const listener: GuestListener = {
      socket,
      id: randomBytes(8).toString('hex'),
      port,
      pending: new Map(),
      counts: { next: 0 },
    };

    listeners.set(listener.id, listener);
    ports.set(port, listener);

    socket.once('close', () => {
      listeners.delete(listener.id);
      ports.delete(port);
    });

    socket.write(
      encodeMessageFrame(FRAME_TYPES.response, ListeningSchema, {
        ok: true,
        listener: listener.id,
        port,
      }),
    );
  };

  const acceptConnection = (socket: Socket, request: Readonly<Request>): void => {
    const listener = listeners.get(request.listener ?? '');
    const pending = listener?.pending.get(request.connection ?? 0);

    if (listener === undefined || pending === undefined) {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
          error: {
            code: 'NO_CONNECTION',
            message: `no waiting connection ${String(request.connection)} on listener "${request.listener ?? ''}"`,
          },
        }),
      );

      return;
    }

    listener.pending.delete(request.connection ?? 0);

    const stream = createGuestStream(socket);

    streams.set(socket, stream);

    socket.once('close', () => {
      streams.delete(socket);
    });

    socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
    pending.resolve(stream);
  };

  const readFrame = (socket: Socket, request: AgentFrame, frames: readonly AgentFrame[]): void => {
    if (frames.length > 1) {
      relayFrame(streams.get(socket), frames.at(-1));

      return;
    }

    socket.on('error', () => {});

    const parsed = decodeMessageFrame(RequestSchema, request);

    if (parsed.op === 'listen' && parsed.network === 'tcp') {
      openListener(socket, parsed);
    } else if (parsed.op === 'agent.accept') {
      acceptConnection(socket, parsed);
    } else {
      socket.end(
        encodeMessageFrame(FRAME_TYPES.response, ErrorResponseSchema, {
          error: { code: 'UNKNOWN_OP', message: `the test guest has no op ${parsed.op}` },
        }),
      );
    }
  };

  await startStubAgent(vsockPath, readFrame, { stack });

  const guest: TestGuest = {
    connect: (port) => {
      const listener = ports.get(port);

      if (listener === undefined) {
        return Promise.reject(new Error(`no reverse forward listens on port ${String(port)}`));
      }

      listener.counts.next += 1;

      const id = listener.counts.next;
      const accept = Promise.withResolvers<Duplex>();

      listener.pending.set(id, accept);
      listener.socket.write(encodeMessageFrame(FRAME_TYPES.connection, ConnectionSchema, { id }));

      return accept.promise;
    },
    listPorts: () => [...ports.keys()],
  };

  return {
    guest,
    endConnections: () => {
      const sockets = [
        ...[...listeners.values()].map((listener) => listener.socket),
        ...streams.keys(),
      ];

      for (const socket of sockets) {
        socket.destroy();
      }
    },
  };
}

// the first port the stand-in hands out for a forward that asks for port 0
const FIRST_EPHEMERAL_PORT = 32_768;

function pickFreePort(ports: ReadonlyMap<number, GuestListener>): number {
  let port = FIRST_EPHEMERAL_PORT;

  while (ports.has(port)) {
    port += 1;
  }

  return port;
}

// The process's side of an accepted connection. Its end sends STDOUT_EOF, as pumpOut does at EOF;
// a destroy drops the agent connection with no STDOUT_EOF, which impd reads as a reset.
function createGuestStream(socket: Socket): Duplex {
  const stream = new Duplex({
    read: () => {},
    write: (chunk: Uint8Array, _encoding, done) => {
      socket.write(encodeFrame(FRAME_TYPES.stdout, chunk), done);
    },
    final: (done) => {
      socket.write(encodeFrame(FRAME_TYPES.stdoutEof), done);
    },
    destroy: (error, done) => {
      socket.destroy();

      done(error);
    },
  });

  socket.once('close', () => {
    stream.push(null);
  });

  return stream;
}

// STDIN is what the process reads; STDIN_EOF half-closes it, as pumpIn's CloseWrite does
function relayFrame(stream: Duplex | undefined, frame: AgentFrame | undefined): void {
  if (stream === undefined || frame === undefined) {
    return;
  }

  if (frame.type === FRAME_TYPES.stdin) {
    stream.push(frame.payload);
  } else if (frame.type === FRAME_TYPES.stdinEof) {
    stream.push(null);
  }
}
