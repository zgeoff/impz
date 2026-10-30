export type TaskPriority = 'foreground' | 'background';

export interface PrioritySemaphore {
  readonly run: <T>(priority: TaskPriority, task: () => Promise<T>) => Promise<T>;
}

// A free slot goes to the oldest waiting foreground task, and to a background
// task only when no foreground task waits.
export function createPrioritySemaphore(limit: number): PrioritySemaphore {
  const waiters: Record<TaskPriority, (() => void)[]> = { foreground: [], background: [] };
  let active = 0;

  return {
    run: async <T>(priority: TaskPriority, task: () => Promise<T>): Promise<T> => {
      if (active >= limit) {
        const turn = Promise.withResolvers<void>();

        waiters[priority].push(turn.resolve);

        await turn.promise;
      } else {
        active += 1;
      }

      try {
        return await task();
      } finally {
        const next = waiters.foreground.shift() ?? waiters.background.shift();

        if (next === undefined) {
          active -= 1;
        } else {
          next();
        }
      }
    },
  };
}
