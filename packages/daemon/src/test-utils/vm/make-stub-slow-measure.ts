import type { FakeClock } from '@zgeoff/testing/clock';
import type { DiskUsageReport, StorageBackend } from '../../vm/storage/storage-backend';

export function makeStubSlowMeasure(
  clock: Pick<FakeClock, 'advance'>,
  durationMs: number,
  report: DiskUsageReport,
): StorageBackend['measureUsage'] {
  return () => {
    clock.advance(durationMs);

    return Promise.resolve(report);
  };
}
