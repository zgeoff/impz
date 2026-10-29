import { runCommand } from '../../platform/process/run-command';
import type { FirecrackerClient, SnapshotType } from './firecracker-client';

interface SnapshotBases {
  // the memory file a VM woke from, which a VM that tracks dirty pages builds on
  readonly memFile: string;

  // the file a page handler serves a 2 MiB VM from, or null for one that booted
  // with no handler, whose untouched memory is zero
  readonly servedFile: string | null;
}

interface SnapshotPlan {
  readonly step: 'copyBase' | 'copyBaseFailed' | null;
  readonly type: SnapshotType;
}

// A Full snapshot reads every guest page, and on a 2 MiB VM that takes a pool
// page for each block the guest never touched. Firecracker writes a Diff of an
// untracked VM from mincore(2), which finds every block the guest holds.
export async function writeSnapshotBase(
  api: FirecrackerClient,
  bases: Readonly<SnapshotBases>,
  memFile: string,
): Promise<SnapshotPlan> {
  const config = await api.loadMachineConfig().catch(() => null);

  if (config?.hugePages === '2M') {
    return bases.servedFile === null
      ? { step: null, type: 'Diff' }
      : copyBase(bases.servedFile, memFile);
  }

  if (config?.isTrackingDirtyPages !== true) {
    return { step: null, type: 'Full' };
  }

  return copyBase(bases.memFile, memFile);
}

// the copy runs under the imp's lock: a hung one costs the sleep a Full snapshot
const BASE_COPY_TIMEOUT_MS = 120_000;

async function copyBase(base: string, memFile: string): Promise<SnapshotPlan> {
  // The copy is safe while the guest runs, because the guest never writes into the file it maps.
  const copied = await runCommand(['cp', '--reflink=auto', '--sparse=always', base, memFile], {
    signal: AbortSignal.timeout(BASE_COPY_TIMEOUT_MS),
  });

  return copied.exitCode === 0
    ? { step: 'copyBase', type: 'Diff' }
    : { step: 'copyBaseFailed', type: 'Full' };
}
