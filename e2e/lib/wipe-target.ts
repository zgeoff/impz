import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readZfsOwner } from './zfs-owner';
import type { RunZfsCommand, ZfsOwner } from './zfs-owner';

export interface WipeTarget {
  readonly directory: string;
  readonly zfs: ZfsOwner | null;
}

export interface WipeTargetOptions {
  readonly path: string;
  readonly repoRoot: string;

  readonly storageBackend: string | undefined;
  readonly zfsRoot: string | undefined;
  readonly run: RunZfsCommand;
}

// ZFS proof comes first, wherever the dir sits, so a proven pool's root is
// never left behind a wiped database.
export async function resolveWipeTarget(
  options: Readonly<WipeTargetOptions>,
): Promise<WipeTarget | null> {
  if (!existsSync(options.path)) {
    return null;
  }

  const data = realpathSync(options.path);

  if (options.storageBackend === 'zfs') {
    const zfs = await readZfsOwner({ dataDir: data, zfsRoot: options.zfsRoot, run: options.run });

    if (zfs !== null) {
      return { directory: data, zfs };
    }
  }

  const dataRootPath = join(options.repoRoot, '.data');
  const dataRoot = existsSync(dataRootPath) ? realpathSync(dataRootPath) : null;
  const underDataRoot = dataRoot !== null && data.startsWith(`${dataRoot}/`);

  if (underDataRoot || existsSync(join(data, 'imp.xfs'))) {
    return { directory: data, zfs: null };
  }

  throw new Error(
    `refusing to wipe ${data}: it is not under ${dataRootPath}, holds no imp.xfs, ` +
      "and is no data dir of this run's ZFS pool",
  );
}
