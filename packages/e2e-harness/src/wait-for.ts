import { waitFor as waitForAttempt } from '@impz/test-utils/wait-for';
import type { WaitForOptions } from '@impz/test-utils/wait-for';

// A guest boots and a dev instance restarts in seconds, not the unit tests' milliseconds, so a
// journey polls slower and longer, and names what it waited for when it gives up.
export function waitFor<T>(
  what: string,
  attempt: () => Promise<T> | T,
  options: Readonly<Omit<WaitForOptions, 'label'>> = {},
): Promise<T> {
  return waitForAttempt(attempt, { intervalMs: 500, timeoutMs: 60_000, ...options, label: what });
}
