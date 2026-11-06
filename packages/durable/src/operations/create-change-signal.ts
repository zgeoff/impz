export interface ChangeSignal {
  readonly notify: () => void;
  readonly next: (signal: AbortSignal) => Promise<void>;
}

export function createChangeSignal(): ChangeSignal {
  let current = Promise.withResolvers<void>();

  return {
    notify: () => {
      current.resolve();

      current = Promise.withResolvers<void>();
    },
    next: (signal) => {
      const changed = current.promise;
      const aborted = Promise.withResolvers<void>();

      const onAbort = (): void => {
        aborted.resolve();
      };

      if (signal.aborted) {
        return Promise.resolve();
      }

      signal.addEventListener('abort', onAbort, { once: true });

      return Promise.race([changed, aborted.promise]).finally(() => {
        signal.removeEventListener('abort', onAbort);
      });
    },
  };
}
