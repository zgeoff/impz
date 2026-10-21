interface RealTimerOptions {
  readonly isUnref?: boolean;
}

export function startRealTimer(
  fire: () => void,
  durationMs: number,
  options: RealTimerOptions = {},
): () => void {
  const timer = setTimeout(fire, durationMs);

  if (options.isUnref === true) {
    timer.unref();
  }

  return () => {
    clearTimeout(timer);
  };
}
