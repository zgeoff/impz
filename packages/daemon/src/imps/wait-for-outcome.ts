import { waitFor } from '@impz/test-utils/wait-for'; // oxlint-disable-line no-restricted-imports -- a test harness outside test-utils/; GEO-363 moves it to @impz/daemon/testing

// 'done' or 'failed' once the promise settles, 'hung' when it is still
// pending after `ms` of polling its state, read on `clock`
export async function waitForOutcome(
  promise: Promise<unknown>,
  ms: number,
  clock: Readonly<{ now?: () => number; wait?: (ms: number) => Promise<void> }> = {},
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
      { ...clock, timeoutMs: ms },
    );
  } catch {
    return 'hung';
  }

  return settled;
}
