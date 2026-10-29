export interface LatencySummary {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

// nearest rank, so each figure is a sample the bench took and never an
// interpolation between two
export function buildLatencySummary(samples: readonly number[]): LatencySummary | null {
  if (samples.length === 0) {
    return null;
  }

  const sorted = samples.toSorted((left, right) => left - right);

  const pick = (percentile: number): number =>
    sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? 0;

  return { p50: pick(50), p95: pick(95), p99: pick(99), max: sorted.at(-1) ?? 0 };
}
