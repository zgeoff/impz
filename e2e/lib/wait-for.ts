export interface WaitForOptions {
  readonly intervalMs?: number;

  readonly timeoutMs?: number;

  readonly now?: () => number;

  readonly wait?: (durationMs: number) => Promise<void>;
}

export async function waitFor<T>(
  what: string,
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (now() >= deadline) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}: ${reason}`, {
          cause: error,
        });
      }
    }

    await wait(intervalMs);
  }
}
