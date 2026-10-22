import { deserializeMessage, isJSONRPCRequest } from '@modelcontextprotocol/server';
import type { McpServer, RequestId, Transport } from '@modelcontextprotocol/server';
import { createCallRegistry } from '../create-call-registry';
import { createCallerAuth } from '../create-caller-auth';
import type { McpCaller } from '../create-caller-auth';
import { createImpServer } from '../create-imp-server';
import type { ImpServerOptions } from '../create-imp-server';

interface MessageContext extends McpCaller {
  readonly reply: (message: string) => void;
}

interface TestMcpServer {
  readonly receive: (line: string, context: Readonly<MessageContext>) => Promise<void>;
  readonly close: () => Promise<void>;
}

export function createMcpServer(options: Readonly<ImpServerOptions>): TestMcpServer {
  const calls = createCallRegistry();
  const state: { server: McpServer | null } = { server: null };

  const replies = new Map<RequestId, MessageContext['reply']>();
  const waiting = new Map<RequestId, (() => void)[]>();

  const transport: Transport = {
    start: () => Promise.resolve(),
    send: (message, sendOptions) => {
      const isResponse = !('method' in message);
      const id = isResponse ? message.id : sendOptions?.relatedRequestId;

      if (id !== undefined && id !== null) {
        replies.get(id)?.(JSON.stringify(message));
      }

      if (isResponse && id !== undefined && id !== null) {
        waiting.get(id)?.pop()?.();
      }

      return Promise.resolve();
    },
    close: () => {
      transport.onclose?.();

      return Promise.resolve();
    },
  };

  const gate = calls.createGate(transport);

  const openServer = async (caller: Readonly<McpCaller>): Promise<void> => {
    if (state.server === null) {
      state.server = createImpServer(options, caller, calls);

      await state.server.connect(gate);
    }
  };

  return {
    receive: async (line, context) => {
      const message = deserializeMessage(line);

      await openServer(context);

      if (!isJSONRPCRequest(message)) {
        transport.onmessage?.(message, { authInfo: createCallerAuth(context) });

        // The SDK runs a notification's handler on a later microtask.
        await waitForMicrotasks();

        return;
      }

      const answered = Promise.withResolvers<void>();

      replies.set(message.id, context.reply);
      waiting.set(message.id, [...(waiting.get(message.id) ?? []), answered.resolve]);

      // The SDK sends a cancelled call no answer, so the call's end resolves
      // the receive.
      const authInfo = createCallerAuth(context, {
        onCallEnd: () => {
          void (async () => {
            await waitForMicrotasks();

            answered.resolve();
          })();
        },
      });

      transport.onmessage?.(message, { authInfo });

      await answered.promise;
    },
    close: async () => {
      await state.server?.close();
      await calls.drain();
    },
  };
}

// setImmediate fires once every queued microtask, and each one it queues, has
// run.
function waitForMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
