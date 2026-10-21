import { getErrorMessage } from '../../../platform/process/get-error-message';
import { CheckpointIdTakenError } from '../storage-backend';
import type { StorageBackend } from '../storage-backend';
import { getCheckpointSnapshot, listCheckpointSnapshots } from './zfs-commands';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';

interface ZfsCheckpointContext {
  readonly zfs: ZfsCommands;
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runSnapshot: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly log: (message: string) => void;
  readonly setupMount: (name: string, directory: string, isReadOnly?: boolean) => Promise<void>;
  readonly removeMount: (directory: string) => Promise<void>;
  readonly removeDataset: (name: string) => Promise<void>;
  readonly startReclaim: () => void;
  readonly buildDiskName: (impId: string) => string;
  readonly buildDiskDir: (impId: string) => string;
  readonly buildRestoreName: (impId: string) => string;
}

export function createZfsCheckpoints(
  ctx: ZfsCheckpointContext,
): Pick<StorageBackend, 'createCheckpoint' | 'removeCheckpoint' | 'restoreCheckpoint'> {
  const resolveFailedSwap = async (impId: string): Promise<void> => {
    try {
      const entries = await ctx.listAll();

      const names = new Set(entries.map((entry) => entry.name));

      if (!names.has(ctx.buildDiskName(impId))) {
        await ctx.zfs.rename(ctx.buildRestoreName(impId), ctx.buildDiskName(impId));
      } else if (names.has(ctx.buildRestoreName(impId))) {
        await ctx.zfs.destroy(ctx.buildRestoreName(impId));
      }

      await ctx.setupMount(ctx.buildDiskName(impId), ctx.buildDiskDir(impId));
    } catch (error) {
      ctx.log(
        `impd: zfs: ${impId}: the disk swap failed and so did its repair: ${getErrorMessage(error)}`,
      );
    }
  };

  return {
    createCheckpoint: (impId, checkpointId) =>
      ctx.runSnapshot(async () => {
        const entries = await ctx.listAll();

        // ZFS keeps a deleted checkpoint's snapshot while a fork's clone depends on it.
        if (listCheckpointSnapshots(entries, checkpointId).length > 0) {
          throw new CheckpointIdTakenError(checkpointId);
        }

        const snapshot = `${ctx.buildDiskName(impId)}@${checkpointId}`;

        await ctx.zfs.snapshot(snapshot);

        try {
          return await ctx.zfs.readWritten(snapshot);
        } catch (error) {
          await ctx.zfs.destroy(snapshot);

          throw error;
        }
      }),

    removeCheckpoint: async (_impId, checkpointId) => {
      await ctx.runSerial(async () => {
        const entries = await ctx.listAll();

        const snapshots = listCheckpointSnapshots(entries, checkpointId);

        if (snapshots.length > 1) {
          throw new Error(`zfs: ${String(snapshots.length)} snapshots are named ${checkpointId}`);
        }

        const [snapshot] = snapshots;

        if (snapshot !== undefined && !snapshot.deferDestroy) {
          await ctx.zfs.destroyDeferred(snapshot.name);
        }
      });

      ctx.startReclaim();
    },

    restoreCheckpoint: async (impId, checkpointId, halt) => {
      const staged = ctx.buildRestoreName(impId);

      await ctx.runSerial(async () => {
        const entries = await ctx.listAll();

        const snapshot = getCheckpointSnapshot(entries, checkpointId);

        if (entries.some((entry) => entry.name === staged)) {
          await ctx.zfs.destroy(staged);
        }

        await ctx.zfs.clone(snapshot, staged);
      });

      const halted = await halt().catch(async (error: unknown) => {
        try {
          await ctx.runSerial(() => ctx.zfs.destroy(staged));
        } catch (destroyError) {
          ctx.log(`impd: zfs: could not drop ${staged}: ${getErrorMessage(destroyError)}`);
        }

        throw error;
      });

      await ctx.runSerial(async () => {
        await ctx.removeMount(ctx.buildDiskDir(impId));

        try {
          await ctx.removeDataset(ctx.buildDiskName(impId));
          await ctx.zfs.rename(staged, ctx.buildDiskName(impId));
        } catch (error) {
          await resolveFailedSwap(impId);

          throw error;
        }

        await ctx.setupMount(ctx.buildDiskName(impId), ctx.buildDiskDir(impId));
      });

      ctx.startReclaim();

      return halted;
    },
  };
}
