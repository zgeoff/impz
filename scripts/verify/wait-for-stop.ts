import { once } from 'node:events';

// Settles on the first SIGTERM or SIGINT, the signals a run's stop sends the app's group.
export async function waitForStop(): Promise<void> {
  const abandon = new AbortController();

  await Promise.race([
    once(process, 'SIGTERM', { signal: abandon.signal }),
    once(process, 'SIGINT', { signal: abandon.signal }),
  ]);

  abandon.abort();
}
