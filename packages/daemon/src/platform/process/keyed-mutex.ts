export type TryResult<T> = { readonly ran: true; readonly value: T } | { readonly ran: false };

export interface KeyedMutex {
  readonly runExclusive: <T>(key: string, task: () => Promise<T>) => Promise<T>;

  readonly tryRunExclusive: <T>(key: string, task: () => Promise<T>) => Promise<TryResult<T>>;

  readonly isLocked: (key: string) => boolean;

  readonly countQueued: (key: string) => number;

  readonly waitForAll: () => Promise<void>;
}

export function buildKeyedMutex(): KeyedMutex {
  const queues = new Map<string, { tail: Promise<void>; count: number }>();

  const runExclusive = async <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const queue = queues.get(key) ?? { tail: Promise.resolve(), count: 0 };
    const previous = queue.tail;
    const done = Promise.withResolvers<void>();

    queue.tail = done.promise;
    queue.count += 1;

    queues.set(key, queue);

    try {
      await previous;

      return await task();
    } finally {
      done.resolve();

      queue.count -= 1;

      if (queue.count === 0) {
        queues.delete(key);
      }
    }
  };

  return {
    runExclusive,

    tryRunExclusive: async (key, task) => {
      if (queues.has(key)) {
        return { ran: false };
      }

      const value = await runExclusive(key, task);

      return { ran: true, value };
    },
    isLocked: (key) => queues.has(key),
    countQueued: (key) => queues.get(key)?.count ?? 0,
    waitForAll: async () => {
      while (queues.size > 0) {
        await Promise.all([...queues.values()].map((queue) => queue.tail));
      }
    },
  };
}
