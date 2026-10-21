export interface SingleFlight<T> {
  readonly run: (key: string, task: () => Promise<T>) => Promise<T>;

  readonly findRun: (key: string) => Promise<T> | undefined;

  readonly listKeys: () => string[];

  readonly waitForAll: () => Promise<void>;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();

  return {
    run: (key, task) => {
      const running = inflight.get(key);

      if (running !== undefined) {
        return running;
      }

      const settled = Promise.withResolvers<T>();

      inflight.set(key, settled.promise);

      void (async () => {
        try {
          const value = await task();

          settled.resolve(value);
        } catch (error) {
          settled.reject(error);
        } finally {
          inflight.delete(key);
        }
      })();

      return settled.promise;
    },
    findRun: (key) => inflight.get(key),
    listKeys: () => [...inflight.keys()],
    waitForAll: async () => {
      await Promise.allSettled(inflight.values());
    },
  };
}
