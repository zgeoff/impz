export interface StubPrivateService {
  readonly port: number;

  readonly readAccepted: () => number;
  readonly readReceived: () => number;
  readonly stop: () => void;
}

export function startStubPrivateService(hostname: string): StubPrivateService {
  const counts = { accepted: 0, received: 0 };

  const listener = Bun.listen({
    hostname,
    port: 0,
    socket: {
      open: (socket) => {
        counts.accepted += 1;

        socket.write('hello\n');
      },
      data: (_socket, chunk) => {
        counts.received += chunk.byteLength;
      },
    },
  });

  return {
    port: listener.port,
    readAccepted: () => counts.accepted,
    readReceived: () => counts.received,
    stop: () => {
      listener.stop(true);
    },
  };
}
