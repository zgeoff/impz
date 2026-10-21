import type { DialEvent, DialStream } from '../../src/vm/agent-client/dial-stream';

type StubDialItem =
  | { readonly kind: 'event'; readonly event: DialEvent }
  | { readonly kind: 'end' }
  | { readonly kind: 'fail'; readonly error: Error };

interface StubDialQueue {
  readonly items: StubDialItem[];
  wake: (() => void) | null;
}

const decoder = new TextDecoder();

export function buildStubDialStream() {
  const queue: StubDialQueue = { items: [], wake: null };
  const drain = { gate: Promise.resolve() };

  const state = {
    written: [] as string[],
    isEnded: false,
    isClosed: false,

    drainWaits: 0,
  };

  const sendItem = (item: StubDialItem): void => {
    queue.items.push(item);
    queue.wake?.();
  };

  const readNext = async (): Promise<StubDialItem> => {
    while (queue.items.length === 0) {
      await new Promise<void>((resolve) => {
        queue.wake = resolve;
      });
    }

    return queue.items.shift() ?? { kind: 'end' };
  };

  const stream: DialStream = {
    write: (data) => {
      state.written.push(decoder.decode(data));
    },
    drained: () => {
      state.drainWaits += 1;

      return drain.gate;
    },
    end: () => {
      state.isEnded = true;
    },
    events: () => readDialEvents(readNext),

    close: () => {
      state.isClosed = true;

      sendItem({ kind: 'end' });
    },
  };

  return {
    stream,
    state,

    emit: (event: DialEvent): void => {
      sendItem({ kind: 'event', event });
    },

    end: (): void => {
      sendItem({ kind: 'end' });
    },

    fail: (error: Error): void => {
      sendItem({ kind: 'fail', error });
    },

    countUnread: (): number => queue.items.length,

    holdDrain: (): (() => void) => {
      const held = Promise.withResolvers<void>();

      drain.gate = held.promise;

      return held.resolve;
    },
  };
}

async function* readDialEvents(
  readNext: () => Promise<StubDialItem>,
): AsyncGenerator<DialEvent, void, undefined> {
  for (;;) {
    const item = await readNext();

    if (item.kind === 'end') {
      return;
    }

    if (item.kind === 'fail') {
      throw item.error;
    }

    yield item.event;
  }
}
