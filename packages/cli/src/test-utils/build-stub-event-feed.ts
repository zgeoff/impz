import { once } from 'node:events';
import type { ImpEvent } from '@impz/api';
import type { watchEvents } from '@impz/client';

interface StubEventFeed {
  readonly watchEvents: typeof watchEvents;
  readonly send: (event: ImpEvent) => Promise<void>;
}

// Opens once and stays open until its watcher aborts it, handing each watcher
// every event the test sends.
export function buildStubEventFeed(): StubEventFeed {
  const listeners: ((event: ImpEvent) => Promise<void> | void)[] = [];

  return {
    watchEvents: async (_client, options) => {
      listeners.push(options.onEvent);

      await options.onOpen?.(1);

      if (options.signal !== undefined && !options.signal.aborted) {
        await once(options.signal, 'abort');
      }
    },
    send: async (event) => {
      for (const listener of listeners) {
        await listener(event);
      }
    },
  };
}
