import { existsSync, statSync } from 'node:fs';
import type { ImpPaths } from '../data-layout';
import type { StorageBackend } from '../storage-backend';
import { CHECKPOINT_SNAPSHOT, readSnapshotId } from './zfs-commands';
import type { ZfsCommands } from './zfs-commands';

// what the ZFS backend lends its usage pass: its commands, its root and
// retired datasets, and the names of each imp's disk and files
interface ZfsUsageContext {
  readonly zfs: ZfsCommands;
  readonly root: string;
  readonly datasets: { readonly retired: string };
  readonly buildDiskName: (impId: string) => string;
  readonly resolveImpPaths: (impId: string) => ImpPaths;
}

// Each imp's exclusive and shared bytes, from one listing of the pool's
// space accounting
export function createZfsUsage(ctx: ZfsUsageContext): Pick<StorageBackend, 'measureUsage'> {
  return {
    measureUsage: async (imps) => {
      const space = await ctx.zfs.listSpace(ctx.root);

      const byName = new Map(space.map((entry) => [entry.name, entry]));

      const report = new Map(
        imps.map((imp) => {
          const disk = ctx.buildDiskName(imp.impId);

          const checkpointIds = new Set(imp.checkpointIds);

          // after a restore, the imp's older checkpoints live on a retired
          // dataset; its whole `used` goes with them
          const retiredSnapshots = space.filter(
            (entry) =>
              entry.name.startsWith(`${ctx.datasets.retired}/`) &&
              CHECKPOINT_SNAPSHOT.test(entry.name) &&
              checkpointIds.has(readSnapshotId(entry.name)),
          );

          const retiredNames = new Set(
            retiredSnapshots.map((entry) => entry.name.split('@')[0] ?? ''),
          );

          const snapshots = [
            ...space.filter((entry) => entry.name.startsWith(`${disk}@`)),
            ...retiredSnapshots,
          ];

          const found = byName.get(disk);

          const usage = {
            exclusiveBytes:
              (found?.used ?? 0) +
              [...retiredNames].reduce((sum, name) => sum + (byName.get(name)?.used ?? 0), 0) +
              readAllocatedBytes(ctx.resolveImpPaths(imp.impId).memFile),

            // what it refers to from its origin: the image or a checkpoint
            sharedBytes: Math.max(0, (found?.referenced ?? 0) - (found?.usedByDataset ?? 0)),

            // a fork holds blocks a destroy would otherwise free; the imp's
            // own disk, cloned from a retired checkpoint, is not a fork
            isUpperBound: snapshots.some((entry) => entry.clones.some((clone) => clone !== disk)),
          };

          return [imp.impId, usage];
        }),
      );

      return { imps: report, isPartial: false };
    },
  };
}

function readAllocatedBytes(path: string): number {
  return existsSync(path) ? statSync(path).blocks * 512 : 0;
}
