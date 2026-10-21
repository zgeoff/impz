import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { BACKUP_TREE, buildBackupPaths, toDigestHex } from '../data-layout';
import type { StorageBackend } from '../storage-backend';
import { listCheckpointSnapshots, parseZfsMounts } from './zfs-commands';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';

interface ZfsBackupContext {
  readonly zfs: ZfsCommands;
  readonly dataDir: string;
  readonly datasets: { readonly staging: string };
  readonly runSerial: <T>(task: () => Promise<T>) => Promise<T>;
  readonly runSnapshot: <T>(task: () => Promise<T>) => Promise<T>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly log: (message: string) => void;
  readonly readMounts: () => string;
  readonly setupMount: (name: string, directory: string, isReadOnly?: boolean) => Promise<void>;
  readonly removeMount: (directory: string) => Promise<void>;
  readonly startReclaim: () => void;
  readonly buildDiskName: (impId: string) => string;
  readonly buildImageName: (digest: string) => string;
}

export function createZfsBackups(
  ctx: ZfsBackupContext,
): Pick<StorageBackend, 'createBackupCopy' | 'openBackupTree'> {
  return {
    createBackupCopy: (impId, runId) =>
      ctx.runSnapshot(() => ctx.zfs.snapshot(`${ctx.buildDiskName(impId)}@bk-${runId}-${impId}`)),

    // ZFS drops a snapshot marked for deferred destroy with its last clone, so each disk copy is
    // marked at once and a removed imp's retired disk goes once the run closes.
    openBackupTree: async (request) => {
      const tree = buildBackupPaths(ctx.dataDir).tree;
      const clones: { name: string; directory: string }[] = [];

      const impIds = new Set<string>();
      const checkpointIds = new Set<string>();
      const imageDigests = new Set<string>();

      const removeClones = async () => {
        await ctx.runSerial(async () => {
          for (const clone of clones.splice(0)) {
            await ctx.removeMount(clone.directory);
            await ctx.zfs.destroy(clone.name);
          }

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
        const directory = join(tree, relativeDir);

        await ctx.zfs.clone(snapshot, name, { readonly: 'on' });

        clones.push({ name, directory });

        await ctx.setupMount(name, directory, true);
      };

      const createTreeClones = async () => {
        const mounted = [...parseZfsMounts(ctx.readMounts()).keys()].find((directory) =>
          directory.startsWith(`${tree}/`),
        );

        if (mounted !== undefined) {
          throw new Error(`zfs: ${mounted} in the backup tree is still mounted`);
        }

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
          ctx.log(`impd: zfs: could not close the backup tree: ${getErrorMessage(closeError)}`);
        });

        throw error;
      }

      return { impIds, checkpointIds, imageDigests, close: removeClones };
    },
  };
}
