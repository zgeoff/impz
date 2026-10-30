import type { BenchResult } from './bench-report-schema';

export function findBenchFailure(
  results: readonly BenchResult[],
  limitMs: number | null,
): string | null {
  const empty = results.find((result) => result.latencyMs === null);

  if (empty !== undefined) {
    return `bench: ${empty.scenario} at ${String(empty.concurrency)} took no sample`;
  }

  if (limitMs === null) {
    return null;
  }

  for (const result of results) {
    const p50 = result.latencyMs?.p50 ?? 0;

    if (p50 > limitMs) {
      return `bench: the median ${result.scenario} at ${String(result.concurrency)} took ${String(p50)}ms, past ${String(limitMs)}ms`;
    }
  }

  return null;
}
