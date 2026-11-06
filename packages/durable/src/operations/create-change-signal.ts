export interface ChangeSignal {
  readonly notify: () => void;
  readonly next: (signal: AbortSignal) => Promise<void>;
}

export function createChangeSignal(): ChangeSignal {
  const waiters = new Set<() => void>();

  return {
    notify: () => {
      for (const settle of waiters) {
        settle();
      }
    },
    next: (signal) => {
      if (signal.aborted) {
        return Promise.resolve();
      }

      const settled = Promise.withResolvers<void>();

      const settle = (): void => {
        waiters.delete(settle);
        signal.removeEventListener('abort', settle);
        settled.resolve();
      };

      waiters.add(settle);
      signal.addEventListener('abort', settle, { once: true });

      return settled.promise;
    },
  };
}
