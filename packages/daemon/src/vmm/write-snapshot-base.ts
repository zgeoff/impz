import { runCommand } from '../process/run-command';
import type { FirecrackerClient } from './firecracker-client';

// the copy runs under the imp's lock: a hung one costs the sleep a Full snapshot
const BASE_COPY_TIMEOUT_MS = 120_000;

// `base` copied over `memFile`, holes kept and blocks cloned where the
// filesystem can, while the guest runs: it never writes into the file it maps
export async function writeSnapshotBase(
  api: FirecrackerClient,
  base: string,
  memFile: string,
): Promise<'copyBase' | 'copyBaseFailed' | null> {
  const config = await api.loadMachineConfig().catch(() => null);

  // a VM that does not track its dirty pages takes a Full snapshot
  if (config?.isTrackingDirtyPages !== true) {
    return null;
  }

  const copied = await runCommand(['cp', '--reflink=auto', '--sparse=always', base, memFile], {
    signal: AbortSignal.timeout(BASE_COPY_TIMEOUT_MS),
  });

  // a Full snapshot then writes every page over what the copy left
  return copied.exitCode === 0 ? 'copyBase' : 'copyBaseFailed';
}
