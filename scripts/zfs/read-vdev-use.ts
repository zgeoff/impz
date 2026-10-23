import type { DevShell } from '../dev/types.ts';
import { hasVdevLine } from './has-vdev-line.ts';

// unknown: zpool cannot say, as when it or sudo cannot reach the kernel.
type VdevUse = 'used' | 'unused' | 'unknown';

interface ReadVdevUseOptions {
  readonly shell: DevShell;
  readonly zpool: readonly string[];
  readonly vdev: string;

  // null asks whether any pool uses the vdev.
  readonly pool: string | null;
}

export async function readVdevUse(options: ReadVdevUseOptions): Promise<VdevUse> {
  const shell = options.shell;
  const zpool = options.zpool;

  const listed = await shell`${zpool} list -H -o name`.quiet().nothrow();

  if (listed.exitCode !== 0) {
    return 'unknown';
  }

  const pools = listed.stdout.toString().split('\n');

  if (options.pool !== null && !pools.includes(options.pool)) {
    return 'unused';
  }

  const target = options.pool === null ? [] : [options.pool];

  const status = await shell`${zpool} status -P ${target}`.quiet().nothrow();

  if (status.exitCode !== 0) {
    return 'unknown';
  }

  return hasVdevLine(status.stdout.toString(), options.vdev) ? 'used' : 'unused';
}
