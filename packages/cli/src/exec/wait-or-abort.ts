// an abort clears the timer, so a wait left behind keeps no process alive
export function waitOrAbort(durationMs: number, signal: AbortSignal): Promise<void> {
  const waited = Promise.withResolvers<void>();

  const onAbort = (): void => {
    clearTimeout(timer);

    waited.resolve();
  };

  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    waited.resolve();
  }, durationMs);

  signal.addEventListener('abort', onAbort, { once: true });

  return waited.promise;
}
