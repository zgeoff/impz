import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readErrorMessage } from '../../read-error-message';
import { BACKUP_TREE, buildBackupPaths, toDigestHex } from '../data-layout';
import type { StorageBackend } from '../storage-backend';
import { listCheckpointSnapshots, parseZfsMounts } from './zfs-commands';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';

// what the ZFS backend lends its backups: its commands, its lanes, its
// reclaim, and the names of its datasets and their mounts
interface ZfsBackupContext {
  readonly zfs: ZfsCommands;
  readonly dataDir: string;
  readonly datasets: { readonly staging: string };
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runSnapshot: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly log: (message: string) => void;
  readonly readMounts: () => string;
  readonly setupMount: (name: string, dir: string, isReadOnly?: boolean) => Promise<void>;
  readonly removeMount: (dir: string) => Promise<void>;
  readonly startReclaim: () => void;
  readonly buildDiskName: (impId: string) => string;
  readonly buildImageName: (digest: string) => string;
}

// A backup run's side of the ZFS backend: a snapshot of each disk, then
// read-only clones of them mounted in the backup tree
export function createZfsBackups(
  ctx: ZfsBackupContext,
): Pick<StorageBackend, 'createBackupCopy' | 'openBackupTree'> {
  return {
    // the frozen guest waits for no reclaim, as with a checkpoint
    createBackupCopy: (impId, runId) =>
      ctx.runSnapshot(() => ctx.zfs.snapshot(`${ctx.buildDiskName(impId)}@bk-${runId}-${impId}`)),

    // Read-only clones in staging, mounted in the tree. Each disk copy is
    // marked at once, so ZFS drops it with its clone and a removed imp's
    // retired disk goes once the run closes.
    openBackupTree: async (request) => {
      const tree = buildBackupPaths(ctx.dataDir).tree;
      const clones: { name: string; dir: string }[] = [];

      const impIds = new Set<string>();
      const checkpointIds = new Set<string>();
      const imageDigests = new Set<string>();

      const removeClones = async () => {
        await ctx.runSerial(async () => {
          for (const clone of clones.splice(0)) {
            await ctx.removeMount(clone.dir);
            await ctx.zfs.destroy(clone.name);
          }

          // a copy that never made it into the tree
          const entries = await ctx.listAll();

          for (const snapshot of entries) {
            const isLeft = snapshot.type === 'snapshot' && !snapshot.deferDestroy;

            if (isLeft && snapshot.name.includes(`@bk-${request.runId}-`)) {
              await ctx.zfs.destroyDeferred(snapshot.name);
            }
          }
        });

        ctx.startReclaim();
      };

      const createTreeClone = async (snapshot: string, name: string, relativeDir: string) => {
        const dir = join(tree, relativeDir);

        await ctx.zfs.clone(snapshot, name, { readonly: 'on' });

        clones.push({ name, dir });

        await ctx.setupMount(name, dir, true);
      };

      const createTreeClones = async () => {
        const mounted = [...parseZfsMounts(ctx.readMounts()).keys()].find((dir) =>
          dir.startsWith(`${tree}/`),
        );

        if (mounted !== undefined) {
          throw new Error(`zfs: ${mounted} in the backup tree is still mounted`);
        }

        // empty mount points of the last run
        rmSync(join(tree, 'imps'), { recursive: true, force: true });
        rmSync(join(tree, 'images'), { recursive: true, force: true });

        const entries = await ctx.listAll();

        for (const imp of request.imps) {
          const copy = entries.find(
            (entry) =>
              entry.type === 'snapshot' && entry.name.endsWith(`@bk-${request.runId}-${imp.impId}`),
          );

          if (copy === undefined) {
            continue;
          }

          const diskDir = dirname(BACKUP_TREE.buildDisk(imp.impId));

          await createTreeClone(copy.name, `${ctx.datasets.staging}/bk-${imp.impId}`, diskDir);

          await ctx.zfs.destroyDeferred(copy.name);

          impIds.add(imp.impId);

          for (const checkpointId of imp.checkpointIds) {
            const [snapshot, ...others] = listCheckpointSnapshots(entries, checkpointId);

            // deleted since the database copy
            if (snapshot === undefined || others.length > 0 || snapshot.deferDestroy) {
              continue;
            }

            const checkpointDir = dirname(BACKUP_TREE.buildCheckpointDisk(imp.impId, checkpointId));

            await createTreeClone(
              snapshot.name,
              `${ctx.datasets.staging}/bkc-${checkpointId}`,
              checkpointDir,
            );

            checkpointIds.add(checkpointId);
          }
        }

        for (const digest of request.imageDigests) {
          const base = entries.find((entry) => entry.name === `${ctx.buildImageName(digest)}@base`);

          if (base === undefined || base.deferDestroy) {
            continue;
          }

          const name = `${ctx.datasets.staging}/bki-${toDigestHex(digest)}`;

          await createTreeClone(base.name, name, BACKUP_TREE.buildImageDir(digest));

          imageDigests.add(digest);
        }
      };

      try {
        await ctx.runSerial(createTreeClones);
      } catch (error) {
        await removeClones().catch((closeError: unknown) => {
          ctx.log(`impd: zfs: could not close the backup tree: ${readErrorMessage(closeError)}`);
        });

        throw error;
      }

      return { impIds, checkpointIds, imageDigests, close: removeClones };
    },
  };
}
