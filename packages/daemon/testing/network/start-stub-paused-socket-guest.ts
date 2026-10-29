import type { Socket, SocketHandler } from 'bun';

interface StubPausedGuestOptions {
  readonly port: number;
  readonly host: string;
  readonly path: string;

  // reach the host through a CONNECT on the port, then TLS that trusts `ca`
  readonly tunnel?: { readonly ca: string };
}

// A WebSocket client that upgrades and then stops reading. Bun's WebSocket
// always reads, and a node:tls socket reads on after a pause, so it speaks
// the handshake by hand on Bun's sockets.
export async function startStubPausedSocketGuest(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubPausedGuestOptions>,
) {
  const closed = Promise.withResolvers<void>();
  const reader = buildHeadReader();

  // once TLS runs, the plain socket's handler sees the encrypted bytes too
  const plain = { isRead: true };

  const handler: SocketHandler = {
    data: (_socket, data) => {
      reader.push(data);
    },
    close: () => {
      closed.resolve();
    },
    error: () => {},
  };

  const raw = await Bun.connect({
    hostname: '127.0.0.1',
    port: options.port,
    socket: {
      ...handler,
      data: (_socket, data) => {
        if (plain.isRead) {
          reader.push(data);
        }
      },
    },
  });

  stack.defer(() => {
    raw.terminate();
  });

  let socket: Socket<unknown> = raw;

  if (options.tunnel !== undefined) {
    raw.write(`CONNECT ${options.host}:443 HTTP/1.1\r\nHost: ${options.host}:443\r\n\r\n`);

    await reader.next();

    const secured = Promise.withResolvers<void>();

    plain.isRead = false;

    const upgraded = raw.upgradeTLS({
      tls: { ca: options.tunnel.ca, serverName: options.host },
      socket: {
        ...handler,
        handshake: () => {
          secured.resolve();
        },
      },
    });

    socket = upgraded[1];

    await secured.promise;
  }

  socket.write(
    `GET ${options.path} HTTP/1.1\r\nHost: ${options.host}\r\nConnection: Upgrade\r\n` +
      'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\n' +
      `Sec-WebSocket-Key: ${Buffer.from('imp-test-socket!').toString('base64')}\r\n\r\n`,
  );

  const head = await reader.next();

  socket.pause();
  raw.pause();

  return {
    head,
    closed: closed.promise,
    resume: (): void => {
      raw.resume();
      socket.resume();
    },
  };
}

// Hands out each HTTP head in turn, and drops the bytes after it.
function buildHeadReader() {
  const state: { buffered: string; waiting: PromiseWithResolvers<string> | null } = {
    buffered: '',
    waiting: null,
  };

  const settle = (): void => {
    const end = state.buffered.indexOf('\r\n\r\n');

    if (state.waiting === null || end === -1) {
      return;
    }

    const head = state.buffered.slice(0, end);

    state.buffered = '';

    state.waiting.resolve(head);

    state.waiting = null;
  };

  return {
    push: (data: Buffer): void => {
      if (state.waiting !== null) {
        state.buffered += data.toString('latin1');

        settle();
      }
    },
    next: (): Promise<string> => {
      state.waiting = Promise.withResolvers<string>();

      settle();

      return state.waiting.promise;
    },
  };
}
