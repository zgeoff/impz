export interface Semaphore {
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  const waiters: (() => void)[] = [];
  let active = 0;

  return {
    run: async <T>(task: () => Promise<T>): Promise<T> => {
      if (active >= limit) {
        const turn = Promise.withResolvers<void>();

        waiters.push(turn.resolve);

        await turn.promise;
      } else {
        active += 1;
      }

      try {
        return await task();
      } finally {
        const next = waiters.shift();

        if (next === undefined) {
          active -= 1;
        } else {
          next();
        }
      }
    },
  };
}
