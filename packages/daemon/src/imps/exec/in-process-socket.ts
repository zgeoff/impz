import type { ExecSocket } from '@impz/client';
import type { ExecPeer } from './exec-session';

export interface InProcessServer {
  readonly handleMessage: (message: unknown) => void;
  readonly handleClose: () => void;
}

type ReadyState = ExecSocket['readyState'];

const OPEN: ReadyState = 1;
const CLOSED: ReadyState = 3;
const CLOSE_NORMAL = 1000;
const CLOSE_REFUSED = 1008;

export function createInProcessSocket(
  accept: (peer: ExecPeer) => InProcessServer | null,
): ExecSocket {
  const events = new EventTarget();

  const state: { readyState: ReadyState; server: InProcessServer | null } = {
    readyState: 0,
    server: null,
  };

  const emitEvent = (buildEvent: () => Event): void => {
    // Every delivery waits a microtask, as a real WebSocket's would.
    queueMicrotask(() => {
      events.dispatchEvent(buildEvent());
    });
  };

  const stopSocket = (code: number, reason: string): void => {
    if (state.readyState === CLOSED) {
      return;
    }

    state.readyState = CLOSED;
    state.server?.handleClose();
    emitEvent(() => new CloseEvent('close', { code, reason }));
  };

  const peer: ExecPeer = {
    sendText: (text) => {
      emitEvent(() => new MessageEvent('message', { data: text }));
    },
    sendBinary: (data) => {
      // The sender may reuse its buffer before the delivery.
      const copy = Uint8Array.from(data).buffer;

      emitEvent(() => new MessageEvent('message', { data: copy }));

      return true;
    },
    close: (code = CLOSE_NORMAL, reason = '') => {
      stopSocket(code, reason);
    },
    readBufferedAmount: () => 0,
  };

  queueMicrotask(() => {
    state.server = accept(peer);

    if (state.server === null) {
      stopSocket(CLOSE_REFUSED, 'unauthorized');

      return;
    }

    state.readyState = OPEN;

    events.dispatchEvent(new Event('open'));
  });

  const handleIncoming = (message: unknown): void => {
    queueMicrotask(() => {
      if (state.readyState === OPEN) {
        state.server?.handleMessage(message);
      }
    });
  };

  return {
    binaryType: 'arraybuffer',
    get readyState() {
      return state.readyState;
    },
    bufferedAmount: 0,
    send: (data) => {
      if (typeof data === 'string') {
        handleIncoming(parseControl(data));
      } else if (ArrayBuffer.isView(data)) {
        handleIncoming(
          Uint8Array.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
        );
      }
    },
    close: () => {
      stopSocket(CLOSE_NORMAL, '');
    },

    addEventListener: (type: string, listener: Parameters<EventTarget['addEventListener']>[1]) => {
      events.addEventListener(type, listener);
    },
  };
}

// Elysia hands a WebSocket route a text frame as parsed JSON, or as the raw string when it is not
// JSON.
function parseControl(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
