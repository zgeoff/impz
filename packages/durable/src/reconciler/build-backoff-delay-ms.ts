const MAX_INTERVALS = 10;

export function buildBackoffDelayMs(
  intervalMs: number,
  consecutiveErrors: number,
  random: number,
): number {
  if (consecutiveErrors === 0) {
    return intervalMs;
  }

  const ceilingMs = Math.min(intervalMs * 2 ** consecutiveErrors, intervalMs * MAX_INTERVALS);

  return Math.round(ceilingMs / 2 + (ceilingMs / 2) * random);
}
