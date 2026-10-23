import { join } from 'node:path';
import { DevError } from './dev-error.ts';
import { ZFS_POOL_FILE, parseZfsPoolProperties } from './parse-zfs-pool-properties.ts';

interface PoolFileReader {
  // A file that cannot be read gives null.
  readonly readText: (path: string) => string | null;
}

// The properties deploy/bootstrap.sh gives a pool, as zpool create's words before the pool name.
export function readZfsPoolProperties(files: PoolFileReader, root: string): readonly string[] {
  const json = files.readText(join(root, ZFS_POOL_FILE));

  if (json === null) {
    throw new DevError(`cannot read ${ZFS_POOL_FILE}`);
  }

  try {
    return parseZfsPoolProperties(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new DevError(message);
  }
}
