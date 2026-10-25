import { createCheckpoint } from '../../platform/db/checkpoints';
import type { ImpDatabase } from '../../platform/db/open-database';
import { CheckpointIdTakenError } from '../../vm/storage/storage-backend';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import { buildCheckpointId } from '../checkpoints/checkpoint-service';

export interface CheckpointReplayDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'createImpDisk' | 'resolveImpPaths' | 'createCheckpoint'>;
}

interface ReplayedCheckpoint {
  readonly label: string | null;
  readonly createdAt: Date;
  readonly diskBytes: number;
}

interface ReplayCheckpointsOptions<T extends ReplayedCheckpoint> {
  readonly impId: string;
  readonly checkpoints: readonly T[];
  readonly writeCheckpoint: (checkpoint: T, index: number, disk: string) => Promise<void>;
}

// Each checkpoint goes over the one empty disk in turn, oldest first, so the checkpoints share every
// block they shared where they came from. The caller writes the last disk over the path it returns.
export async function replayCheckpoints<T extends ReplayedCheckpoint>(
  deps: CheckpointReplayDeps,
  options: ReplayCheckpointsOptions<T>,
): Promise<string> {
  const impId = options.impId;

  await deps.storage.createImpDisk(impId, { kind: 'empty' });

  const disk = deps.storage.resolveImpPaths(impId).disk;

  for (const [index, checkpoint] of options.checkpoints.entries()) {
    await options.writeCheckpoint(checkpoint, index, disk);

    const made = await createCheckpointDisk(deps, impId);

    await createCheckpoint(deps.db, {
      id: made.id,
      impId,
      label: checkpoint.label,
      sizeBytes: made.sizeBytes,
      createdAt: checkpoint.createdAt,
      diskBytes: checkpoint.diskBytes,
    });
  }

  return disk;
}

const ID_ATTEMPTS = 5;

// ZFS can still hold a deleted checkpoint's id in a snapshot a fork needs.
async function createCheckpointDisk(deps: CheckpointReplayDeps, impId: string) {
  for (let attempt = 1; ; attempt += 1) {
    const id = buildCheckpointId();

    try {
      return { id, sizeBytes: await deps.storage.createCheckpoint(impId, id) };
    } catch (error) {
      if (!(error instanceof CheckpointIdTakenError) || attempt >= ID_ATTEMPTS) {
        throw error;
      }
    }
  }
}
