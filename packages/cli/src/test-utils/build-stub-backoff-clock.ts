export function buildStubBackoffClock(options: Readonly<{ at: number; onWait: () => void }>) {
  const state = { nowMs: 0 };
  const delays: number[] = [];

  const wait = (durationMs: number): Promise<void> => {
    delays.push(durationMs);

    state.nowMs += durationMs;

    if (delays.length === options.at) {
      options.onWait();
    }

    return Promise.resolve();
  };

  return {
    wait,
    delays,
    now: (): number => state.nowMs,
    advance: (durationMs: number): void => {
      state.nowMs += durationMs;
    },
  };
}
