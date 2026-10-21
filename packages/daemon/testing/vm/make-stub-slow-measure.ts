import type { DiskUsageReport, StorageBackend } from '../../src/vm/storage/storage-backend';

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
