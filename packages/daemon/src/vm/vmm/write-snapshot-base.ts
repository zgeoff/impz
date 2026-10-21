import { runCommand } from '../../platform/process/run-command';
import type { FirecrackerClient } from './firecracker-client';

// the copy runs under the imp's lock: a hung one costs the sleep a Full snapshot
const BASE_COPY_TIMEOUT_MS = 120_000;

export async function writeSnapshotBase(
  api: FirecrackerClient,
  base: string,
  memFile: string,
): Promise<'copyBase' | 'copyBaseFailed' | null> {
  const config = await api.loadMachineConfig().catch(() => null);

  if (config?.isTrackingDirtyPages !== true) {
    return null;
  }

  // The copy is safe while the guest runs, because the guest never writes into the file it maps.
  const copied = await runCommand(['cp', '--reflink=auto', '--sparse=always', base, memFile], {
    signal: AbortSignal.timeout(BASE_COPY_TIMEOUT_MS),
  });

  return copied.exitCode === 0 ? 'copyBase' : 'copyBaseFailed';
}
