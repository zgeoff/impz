import { join } from 'node:path';
import { DevError } from '../lib/dev-error.ts';
import { ZFS_POOL_FILE, parseZfsPool } from '../lib/parse-zfs-pool.ts';
import type { ZfsFiles } from './types.ts';

// The properties deploy/bootstrap.sh gives a pool, as zpool create's words before the pool name.
export function readZfsPoolProperties(files: ZfsFiles, root: string): readonly string[] {
  const json = files.readText(join(root, ZFS_POOL_FILE));

  if (json === null) {
    throw new DevError(`cannot read ${ZFS_POOL_FILE}`);
  }

  try {
    return parseZfsPool(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new DevError(message);
  }
}
