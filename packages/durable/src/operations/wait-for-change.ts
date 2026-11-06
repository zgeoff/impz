import type { ChangeSignal } from './create-change-signal';

interface WaitForChangeInput<T> {
  readonly read: () => Promise<T>;
  readonly isChanged: (value: T) => boolean;
  readonly signal: AbortSignal;
}

export async function waitForChange<T>(
  changes: ChangeSignal,
  input: WaitForChangeInput<T>,
): Promise<T> {
  const wait = new AbortController();

  const stop = (): void => {
    wait.abort();
  };

  input.signal.addEventListener('abort', stop, { once: true });

  try {
    return await readUntilChanged(changes, input, wait.signal);
  } finally {
    input.signal.removeEventListener('abort', stop);
    wait.abort();
  }
}

async function readUntilChanged<T>(
  changes: ChangeSignal,
  input: WaitForChangeInput<T>,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    // taken before the read, so a commit between the read and the wait still wakes this loop
    const changed = changes.next(signal);

    const value = await input.read();

    if (input.isChanged(value) || input.signal.aborted) {
      return value;
    }

    await changed;
  }
}
