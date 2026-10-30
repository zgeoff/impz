import { createPrioritySemaphore } from './priority-semaphore';

export interface Semaphore {
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
}

export function createSemaphore(limit: number): Semaphore {
  const semaphore = createPrioritySemaphore(limit);

  return { run: (task) => semaphore.run('foreground', task) };
}
