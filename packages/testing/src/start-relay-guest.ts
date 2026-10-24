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
import type { AgentFrame } from '@impz/agent-protocol';
import { startStubAgent } from '@impz/daemon/testing/start-stub-agent';
import type { TestGuest } from './types';

export interface RelayGuest {
  readonly guest: TestGuest;
  readonly endConnections: () => void;
}

interface GuestListener {
  readonly socket: Socket;
  readonly id: string;
}

// The guest agent's side of a reverse forward. A process in the imp writes stdout frames and reads
// impd's stdin frames, as the Go agent relays them; `endConnections` drops every agent connection,
// as a VM that stops does.
export async function startRelayGuest(
  stack: Readonly<AsyncDisposableStack>,
  vsockPath: string,
): Promise<RelayGuest> {
  const listeners = new Map<number, GuestListener>();
  const accepts = new Map<number, PromiseWithResolvers<Duplex>>();
  const streams = new Map<Socket, Duplex>();

  const counts = { listeners: 0, connections: 0 };

  const readFrame = (socket: Socket, request: AgentFrame, frames: readonly AgentFrame[]): void => {
    if (frames.length > 1) {
      relayFrame(streams.get(socket), frames.at(-1));

      return;
    }

    socket.on('error', () => {});

    const parsed = decodeMessageFrame(RequestSchema, request);

    if (parsed.op === 'listen' && parsed.network === 'tcp') {
      counts.listeners += 1;

      const port = Number(parsed.address?.split(':').at(-1));
      const listener = { socket, id: `fwd${String(counts.listeners)}` };

      listeners.set(port, listener);

      socket.once('close', () => {
        if (listeners.get(port) === listener) {
          listeners.delete(port);
        }
      });

      socket.write(
        encodeMessageFrame(FRAME_TYPES.response, ListeningSchema, {
          ok: true,
          listener: listener.id,
          port,
        }),
      );
    } else if (parsed.op === 'agent.accept' && parsed.connection !== undefined) {
      const stream = createGuestStream(socket);

      streams.set(socket, stream);
      socket.write(encodeMessageFrame(FRAME_TYPES.response, OKSchema, { ok: true }));
      accepts.get(parsed.connection)?.resolve(stream);
      accepts.delete(parsed.connection);
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
      const listener = listeners.get(port);

      if (listener === undefined) {
        return Promise.reject(new Error(`no reverse forward listens on port ${String(port)}`));
      }

      counts.connections += 1;

      const accept = Promise.withResolvers<Duplex>();

      accepts.set(counts.connections, accept);

      listener.socket.write(
        encodeMessageFrame(FRAME_TYPES.connection, ConnectionSchema, { id: counts.connections }),
      );

      return accept.promise;
    },
    listPorts: () => [...listeners.keys()],
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

function createGuestStream(socket: Socket): Duplex {
  const stream = new Duplex({
    read: () => {},
    write: (chunk: Uint8Array, _encoding, done) => {
      socket.write(encodeFrame(FRAME_TYPES.stdout, chunk), done);
    },
    final: (done) => {
      socket.write(encodeFrame(FRAME_TYPES.stdoutEof), done);
    },
  });

  socket.once('close', () => {
    stream.push(null);
  });

  return stream;
}
