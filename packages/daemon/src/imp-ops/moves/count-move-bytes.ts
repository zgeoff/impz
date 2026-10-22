import type { ImpRecord } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { SnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { MoveMode, StorageBackend } from '../../vm/storage/storage-backend';
import { countDataBytes } from './move-frames';
import { openMoveParts } from './open-move-parts';
import { removeMoveParts } from './remove-move-parts';

interface MoveBytesDeps {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly storage: Pick<StorageBackend, 'openMoveSource' | 'resolveImpPaths'>;
  readonly log: (message: string) => void;
}

// `zfs send -nP` only estimates a stream's size, so the ticket allows this
// much more.
const ESTIMATE_SLACK = 1.1;
const ESTIMATE_SLACK_BYTES = 64 * 1024 * 1024;

export async function countMoveBytes(
  deps: MoveBytesDeps,
  imp: ImpRecord,
  mode: MoveMode,
  meta: SnapshotMeta | null,
): Promise<number> {
  const warm = meta === null ? null : { meta, isDriveIncluded: true };

  const opened = await openMoveParts(deps, { imp, mode, isImageIncluded: true, warm });

  try {
    let bytes = 0;

    for (const part of opened.parts) {
      if (part.kind === 'file') {
        bytes += await countDataBytes(part.path);
      }
    }

    if (opened.estimateBytes !== null) {
      bytes += Math.ceil(opened.estimateBytes * ESTIMATE_SLACK) + ESTIMATE_SLACK_BYTES;
    }

    return bytes;
  } finally {
    await removeMoveParts(deps, opened);
  }
}
