import { INVALID_PARAMS, isJSONRPCRequest } from '@modelcontextprotocol/server';
import type { JSONRPCErrorResponse, RequestId, Transport } from '@modelcontextprotocol/server';
import { TOOLS } from './tools/tool-list';

interface Call {
  readonly abort: AbortController;
  readonly cancellable: boolean;
  readonly done: Promise<void>;
}

export interface CallRegistry {
  readonly isRunning: (id: RequestId) => boolean;
  readonly add: (id: RequestId, call: Readonly<Call>) => void;
  readonly remove: (id: RequestId) => void;
  readonly drain: () => Promise<void>;

  // The SDK drops a cancelled request's answer, so the gate keeps the cancel
  // of a call that cannot be cancelled from the SDK.
  readonly createGate: (transport: Transport, onClose?: () => void) => Transport;
}

interface Arrival {
  readonly cancellable: boolean;
  cancelled: boolean;
}

export function createCallRegistry(): CallRegistry {
  const calls = new Map<RequestId, Call>();
  const arriving = new Map<RequestId, Arrival>();

  const isRunning = (id: RequestId): boolean => arriving.has(id) || calls.has(id);

  const holdCancel = (message: unknown): boolean => {
    const requestId = readCancelledRequestID(message);

    if (requestId === null) {
      return false;
    }

    const arrival = arriving.get(requestId);

    if (arrival !== undefined) {
      arrival.cancelled = !arrival.cancellable;

      // The SDK sends a cancelled call no answer, so a call it refuses before
      // the call starts would keep its id.
      if (arrival.cancellable) {
        setImmediate(() => {
          if (arriving.get(requestId) === arrival) {
            arriving.delete(requestId);
          }
        });
      }

      return arrival.cancelled;
    }

    const call = calls.get(requestId);

    if (call === undefined || call.cancellable) {
      return false;
    }

    call.abort.abort(new Error('the client cancelled the call'));

    return true;
  };

  return {
    isRunning,
    add: (id, call) => {
      const arrival = arriving.get(id);

      arriving.delete(id);
      calls.set(id, call);

      if (arrival?.cancelled === true) {
        call.abort.abort(new Error('the client cancelled the call'));
      }
    },
    remove: (id) => {
      calls.delete(id);
    },
    drain: async () => {
      await Promise.all([...calls.values()].map((call) => call.done));
    },
    createGate: (inner, onClose) => {
      const gate: Transport = {
        start: () => inner.start(),
        send: (message, options) => {
          if (!('method' in message) && message.id !== undefined) {
            arriving.delete(message.id);
          }

          return inner.send(message, options);
        },
        close: () => inner.close(),
        get sessionId() {
          return inner.sessionId;
        },
        setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
        setSupportedProtocolVersions: (versions) => inner.setSupportedProtocolVersions?.(versions),
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onmessage = (message, extra) => {
        if (holdCancel(message)) {
          return;
        }

        // The SDK keeps one abort per request id, which a second call with the
        // same id would replace.
        if (isJSONRPCRequest(message) && message.method === 'tools/call') {
          if (isRunning(message.id)) {
            void inner.send(buildDuplicateError(message.id));

            return;
          }

          arriving.set(message.id, {
            cancellable: isCancellable(message.params),
            cancelled: false,
          });
        }

        gate.onmessage?.(message, extra);
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onclose = () => {
        gate.onclose?.();
        onClose?.();
      };

      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- an SDK Transport has only on* hooks
      inner.onerror = (error) => gate.onerror?.(error);

      return gate;
    },
  };
}

function readCancelledRequestID(message: unknown): RequestId | null {
  if (typeof message !== 'object' || message === null || !('method' in message)) {
    return null;
  }

  if (message.method !== 'notifications/cancelled' || !('params' in message)) {
    return null;
  }

  const params: unknown = message.params;

  if (typeof params !== 'object' || params === null || !('requestId' in params)) {
    return null;
  }

  const requestId: unknown = params.requestId;

  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : null;
}

function buildDuplicateError(id: RequestId): JSONRPCErrorResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: INVALID_PARAMS, message: `request ${String(id)} is already running` },
  };
}

function isCancellable(params: unknown): boolean {
  const name =
    typeof params === 'object' && params !== null && 'name' in params ? params.name : null;

  return TOOLS.find((tool) => tool.definition.name === name)?.cancellable ?? true;
}
