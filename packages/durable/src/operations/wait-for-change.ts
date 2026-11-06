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
  for (;;) {
    // taken before the read, so a commit between the read and the wait still wakes this loop
    const changed = changes.next(input.signal);

    const value = await input.read();

    if (input.isChanged(value) || input.signal.aborted) {
      return value;
    }

    await changed;
  }
}
