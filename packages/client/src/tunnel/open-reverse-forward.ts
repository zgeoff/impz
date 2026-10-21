import {
  TUNNEL_CLOSE_LOST,
  TUNNEL_CLOSE_NORMAL,
  TUNNEL_CLOSE_PROTOCOL,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PATH,
  TUNNEL_WINDOW_BYTES,
} from '@impz/api';
import type { TunnelClientMessage, TunnelListen, TunnelServerMessage } from '@impz/api';
import { P, match } from 'ts-pattern';
import { resolveImpdWebSocketUrl } from '../resolve-impd-web-socket-url';
import { parseTunnelServerMessage } from './parse-tunnel-server-message';

export type ReverseGuest =
  | { readonly network: 'unix'; readonly path: Exclude<TunnelListen['path'], undefined> }
  | { readonly network: 'tcp'; readonly port: Exclude<TunnelListen['port'], undefined> };

export interface ReverseListening {
  readonly path: string | null;
  readonly port: number | null;
}

export type ReverseForwardEnd =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'lost' }
  | { readonly kind: 'failed'; readonly code: string | null; readonly message: string }
  | { readonly kind: 'closed'; readonly code: number; readonly reason: string };

export interface ReverseRelayHandlers {
  readonly onData: (data: Uint8Array) => Promise<void> | void;
  readonly onEof: () => void;
  readonly onClose: (lost: boolean) => void;
}

export interface ReverseRelay {
  readonly send: (data: Uint8Array) => boolean;
  readonly waitForRoom: () => Promise<void>;
  readonly sendEof: () => void;
  readonly close: () => void;
}

export interface ReverseForwardOptions {
  readonly baseUrl: string;
  readonly token: string | null;
  readonly name: string;
  readonly guest: ReverseGuest;
  readonly connect: (url: string, headers: Readonly<Record<string, string>>) => WebSocket;
  readonly onConnection: (accept: (handlers: ReverseRelayHandlers) => ReverseRelay) => void;
}

export interface ReverseForward {
  readonly listening: Promise<ReverseListening>;
  readonly ended: Promise<ReverseForwardEnd>;
  readonly stop: () => void;
}

interface SocketTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly connect: ReverseForwardOptions['connect'];
}

export function openReverseForward(options: Readonly<ReverseForwardOptions>): ReverseForward {
  const url = resolveImpdWebSocketUrl(options.baseUrl, TUNNEL_PATH);

  const headers: Record<string, string> =
    options.token === null ? {} : { authorization: `Bearer ${options.token}` };

  const target: SocketTarget = { url: url.href, headers, connect: options.connect };
  const ws = options.connect(url.href, headers);
  const listening = Promise.withResolvers<ReverseListening>();
  const ended = Promise.withResolvers<ReverseForwardEnd>();

  const relays = new Set<ReverseRelay>();

  const state = { listener: '', done: false };

  const waitForListening = async (): Promise<void> => {
    try {
      await listening.promise;
    } catch {
      // the end says why
    }
  };

  void waitForListening();

  const stopForward = (end: ReverseForwardEnd): void => {
    if (state.done) {
      return;
    }

    state.done = true;

    for (const relay of relays) {
      relay.close();
    }

    const why = end.kind === 'failed' ? end.message : `the forward ${end.kind}`;

    listening.reject(new Error(why));
    ended.resolve(end);
  };

  const openClientRelay = (id: number): void => {
    const message: TunnelClientMessage = {
      type: 'accept',
      name: options.name,
      listener: state.listener,
      connection: id,
    };

    options.onConnection((handlers) => {
      const relay = openRelay(target, message, {
        ...handlers,
        onClose: (lost) => {
          relays.delete(relay);
          handlers.onClose(lost);
        },
      });

      relays.add(relay);

      return relay;
    });
  };

  const handleControl = (message: TunnelServerMessage): void => {
    match(message)
      .with({ type: 'listening' }, (listen) => {
        state.listener = listen.listener;

        listening.resolve({ path: listen.path, port: listen.port });
      })
      .with({ type: 'connection' }, (connection) => {
        openClientRelay(connection.id);
      })
      .with({ type: 'error' }, (failure) => {
        stopForward({ kind: 'failed', code: failure.code ?? null, message: failure.message });
      })
      .with({ type: P.union('opened', 'eof', 'ack') }, () => {
        ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
      })
      .exhaustive();
  };

  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify(buildListenMessage(options.name, options.guest)));
  });

  ws.addEventListener('message', (event) => {
    const message =
      event.data instanceof ArrayBuffer ? null : parseTunnelServerMessage(String(event.data));

    if (message === null) {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', (event) => {
    if (event.code === TUNNEL_CLOSE_LOST) {
      stopForward({ kind: 'lost' });
    } else {
      stopForward({ kind: 'closed', code: event.code, reason: event.reason });
    }
  });

  ws.addEventListener('error', () => {});

  return {
    listening: listening.promise,
    ended: ended.promise,
    stop: () => {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(TUNNEL_CLOSE_NORMAL, 'stopped');
      }

      stopForward({ kind: 'stopped' });
    },
  };
}

function openRelay(
  target: SocketTarget,
  accept: TunnelClientMessage,
  handlers: ReverseRelayHandlers,
): ReverseRelay {
  const ws = target.connect(target.url, target.headers);
  const state = { opened: false, unacked: 0, done: false, peerEof: false, guestEof: false };
  const waiters: (() => void)[] = [];
  const pending: Uint8Array[] = [];

  ws.binaryType = 'arraybuffer';

  const wakeWaiters = (): void => {
    for (const wake of waiters.splice(0)) {
      wake();
    }
  };

  const sendText = (message: TunnelClientMessage): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const sendFrames = (data: Uint8Array): void => {
    for (let offset = 0; offset < data.byteLength; offset += TUNNEL_MAX_FRAME_BYTES) {
      ws.send(Uint8Array.from(data.subarray(offset, offset + TUNNEL_MAX_FRAME_BYTES)));
    }
  };

  const stopRelay = (lost: boolean): void => {
    if (state.done) {
      return;
    }

    state.done = true;

    wakeWaiters();

    handlers.onClose(lost);
  };

  const sendAck = async (data: Uint8Array): Promise<void> => {
    await handlers.onData(data);

    sendText({ type: 'ack', bytes: data.byteLength });
  };

  const handleControl = (message: TunnelServerMessage): void => {
    match(message)
      .with({ type: 'opened' }, () => {
        state.opened = true;

        for (const data of pending.splice(0)) {
          sendFrames(data);
        }

        if (state.peerEof) {
          sendText({ type: 'eof' });
        }
      })
      .with({ type: 'eof' }, () => {
        state.guestEof = true;

        handlers.onEof();
      })
      .with({ type: 'ack' }, (ack) => {
        state.unacked -= ack.bytes;

        if (state.unacked <= TUNNEL_WINDOW_BYTES) {
          wakeWaiters();
        }
      })
      .with({ type: P.union('error', 'listening', 'connection') }, () => {
        ws.close(TUNNEL_CLOSE_NORMAL, 'relay failed');

        stopRelay(true);
      })
      .exhaustive();
  };

  ws.addEventListener('open', () => {
    sendText(accept);
  });

  ws.addEventListener('message', (event) => {
    if (event.data instanceof ArrayBuffer) {
      void sendAck(new Uint8Array(event.data));

      return;
    }

    const message = parseTunnelServerMessage(String(event.data));

    if (message === null) {
      ws.close(TUNNEL_CLOSE_PROTOCOL, 'bad message');

      stopRelay(true);
    } else {
      handleControl(message);
    }
  });

  ws.addEventListener('close', (event) => {
    stopRelay(event.code !== TUNNEL_CLOSE_NORMAL);
  });

  // The error event carries no detail, and a close event follows it.
  ws.addEventListener('error', () => {});

  return {
    send: (data) => {
      if (state.done) {
        return true;
      }

      if (state.opened) {
        sendFrames(data);
      } else {
        pending.push(Uint8Array.from(data));
      }

      state.unacked += data.byteLength;

      return state.unacked <= TUNNEL_WINDOW_BYTES;
    },
    waitForRoom: async () => {
      while (!state.done && state.unacked > TUNNEL_WINDOW_BYTES) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
        });
      }
    },
    sendEof: () => {
      state.peerEof = true;

      if (state.opened) {
        sendText({ type: 'eof' });
      }
    },
    close: () => {
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) {
        ws.close(TUNNEL_CLOSE_NORMAL, 'local side closed');
      }

      stopRelay(false);
    },
  };
}

function buildListenMessage(name: string, guest: ReverseGuest): TunnelClientMessage {
  return guest.network === 'tcp'
    ? { type: 'listen', name, network: 'tcp', port: guest.port }
    : { type: 'listen', name, network: 'unix', path: guest.path };
}
