import { existsSync, statSync } from 'node:fs';
import type { ImpPaths } from '../data-layout';
import type { StorageBackend } from '../storage-backend';
import { CHECKPOINT_SNAPSHOT, getSnapshotId } from './zfs-commands';
import type { ZfsCommands } from './zfs-commands';

interface ZfsUsageContext {
  readonly zfs: ZfsCommands;
  readonly root: string;
  readonly datasets: { readonly retired: string };
  readonly buildDiskName: (impId: string) => string;
  readonly resolveImpPaths: (impId: string) => ImpPaths;
}

export function createZfsUsage(ctx: ZfsUsageContext): Pick<StorageBackend, 'measureUsage'> {
  return {
    measureUsage: async (imps) => {
      const space = await ctx.zfs.listSpace(ctx.root);

      const byName = new Map(space.map((entry) => [entry.name, entry]));

      const report = new Map(
        imps.map((imp) => {
          const disk = ctx.buildDiskName(imp.impId);

          const checkpointIds = new Set(imp.checkpointIds);

          // A restore leaves the imp's older checkpoints on a retired dataset, whose whole `used`
          // goes with them.
          const retiredSnapshots = space.filter(
            (entry) =>
              entry.name.startsWith(`${ctx.datasets.retired}/`) &&
              CHECKPOINT_SNAPSHOT.test(entry.name) &&
              checkpointIds.has(getSnapshotId(entry.name)),
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
            sharedBytes: Math.max(0, (found?.referenced ?? 0) - (found?.usedByDataset ?? 0)),

            // A fork's ZFS clone holds blocks that a destroy would otherwise free.
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
