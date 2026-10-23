export interface WaitForOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly wait?: (durationMs: number) => Promise<void>;
  readonly label?: string;
}

export async function waitFor<T>(
  attempt: () => Promise<T> | T,
  options: Readonly<WaitForOptions> = {},
): Promise<T> {
  const intervalMs = options.intervalMs ?? 10;
  const timeoutMs = options.timeoutMs ?? 4000;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? Bun.sleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (now() >= deadline) {
        throw buildTimeoutError(error, timeoutMs, options.label);
      }
    }

    await wait(intervalMs);
  }
}

function buildTimeoutError(error: unknown, timeoutMs: number, label: string | undefined): unknown {
  if (label === undefined) {
    return error;
  }

  const reason = error instanceof Error ? error.message : String(error);

  return new Error(`timed out after ${String(timeoutMs)} ms waiting for ${label}: ${reason}`, {
    cause: error,
  });
}
