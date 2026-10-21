interface StubWaitCall {
  readonly durationMs: number;
  readonly signal: AbortSignal;
  readonly release: () => void;
}

export function buildStubWait() {
  const calls: StubWaitCall[] = [];

  const wait = (durationMs: number, signal: AbortSignal): Promise<void> => {
    const waited = Promise.withResolvers<void>();

    signal.addEventListener(
      'abort',
      () => {
        waited.resolve();
      },
      { once: true },
    );

    calls.push({ durationMs, signal, release: waited.resolve });

    return waited.promise;
  };

  return { wait, calls };
}
