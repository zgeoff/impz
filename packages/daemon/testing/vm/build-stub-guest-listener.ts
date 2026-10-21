import type { GuestListener, ListenSpec } from '../../src/vm/agent-client/listener-stream';

interface StubListenerQueue {
  readonly ids: (number | null)[];
  wake: (() => void) | null;
}

export function buildStubGuestListener(id: string, spec: ListenSpec) {
  const queue: StubListenerQueue = { ids: [], wake: null };
  const state = { isClosed: false };

  const sendId = (next: number | null): void => {
    queue.ids.push(next);
    queue.wake?.();
  };

  const readNext = async (): Promise<number | null> => {
    while (queue.ids.length === 0) {
      await new Promise<void>((resolve) => {
        queue.wake = resolve;
      });
    }

    return queue.ids.shift() ?? null;
  };

  const listener: GuestListener = {
    path: spec.network === 'tcp' ? null : buildUnixPath(id, spec),
    port: spec.network === 'tcp' ? spec.port || 41_000 : null,
    id,
    connections: () => readConnections(readNext),
    close: () => {
      state.isClosed = true;

      sendId(null);
    },
  };

  return {
    listener,
    state,

    connect: (connection: number): void => {
      sendId(connection);
    },

    end: (): void => {
      sendId(null);
    },
  };
}

function buildUnixPath(id: string, spec: ListenSpec): string {
  return spec.network === 'unix' && spec.path !== null ? spec.path : `/run/imp/forward/${id}/sock`;
}

async function* readConnections(
  readNext: () => Promise<number | null>,
): AsyncGenerator<number, void, undefined> {
  for (;;) {
    const next = await readNext();

    if (next === null) {
      return;
    }

    yield next;
  }
}
