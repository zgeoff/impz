import { waitFor } from '@impz/test-utils/wait-for';

export async function waitForOutcome(
  promise: Promise<unknown>,
  durationMs: number,
  clock: Readonly<{ now?: () => number; wait?: (delayMs: number) => Promise<void> }> = {},
): Promise<string> {
  const settled = (async () => {
    try {
      await promise;

      return 'done';
    } catch {
      return 'failed';
    }
  })();

  try {
    await waitFor(
      () => {
        if (Bun.peek.status(settled) === 'pending') {
          throw new Error('still pending');
        }
      },
      { ...clock, timeoutMs: durationMs },
    );
  } catch {
    return 'hung';
  }

  return settled;
}
