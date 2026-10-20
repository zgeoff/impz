import type { DiskUsageReport, StorageBackend } from '../storage/storage-backend';

// A storage backend's `measureUsage` that takes `ms` of the test's clock, as a
// slow XFS measure does: each call moves `clock` on by `ms`, then answers
// `report`.
export function makeStubSlowMeasure(
  clock: Readonly<{ runFor: (delayMs: number) => void }>,
  durationMs: number,
  report: DiskUsageReport,
): StorageBackend['measureUsage'] {
  return () => {
    clock.runFor(durationMs);

    return Promise.resolve(report);
  };
}
