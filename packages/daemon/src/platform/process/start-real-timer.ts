interface RealTimerOptions {
  // true lets the process exit while the timer waits
  readonly isUnref?: boolean;
}

// setTimeout behind the StartTimer shape: fires once after `ms`, and returns
// the cancel.
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
