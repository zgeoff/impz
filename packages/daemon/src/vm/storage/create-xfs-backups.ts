import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as z from 'zod';
import { writeFileDurably } from '../../platform/process/write-file-durably';
import { BACKUP_TREE, buildBackupPaths, buildImagePaths } from './data-layout';
import type { ImpPaths } from './data-layout';
import type { StorageBackend } from './storage-backend';

interface XfsBackupContext {
  readonly dataDir: string;
  readonly cloneFile: (source: string, target: string) => Promise<void>;
  readonly resolveImpPaths: (impId: string) => ImpPaths;
  readonly buildCheckpointDisk: (impId: string, checkpointId: string) => string;
}

// an unchanged disk keeps last run's copy, so restic finds the same file and skips rereading it
const CopiesSchema = z.record(
  z.string(),
  z.object({ ino: z.string(), ctimeNs: z.string(), size: z.string() }),
);

type Copies = z.infer<typeof CopiesSchema>;

export function createXfsBackups(
  ctx: XfsBackupContext,
): Pick<StorageBackend, 'createBackupCopy' | 'openBackupTree'> {
  const backup = buildBackupPaths(ctx.dataDir);

  const freshCopies = new Set<string>();

  const readCopies = (): Copies => {
    try {
      return CopiesSchema.parse(JSON.parse(readFileSync(backup.copies, 'utf8')));
    } catch {
      return {};
    }
  };

  const writeCopies = (copies: Readonly<Copies>): void => {
    mkdirSync(backup.directoryPath, { recursive: true });
    writeFileDurably(backup.copies, JSON.stringify(copies));
  };

  // checkpoints and images never change, so one clone serves every run
  const createTreeClone = async (source: string, target: string): Promise<boolean> => {
    if (!existsSync(source)) {
      return false;
    }

    if (!existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });

      await ctx.cloneFile(source, `${target}.new`);

      renameSync(`${target}.new`, target);
    }

    return true;
  };

  return {
    createBackupCopy: async (impId, _runId, options) => {
      const source = ctx.resolveImpPaths(impId).disk;
      const target = join(backup.tree, BACKUP_TREE.buildDisk(impId));
      const stats = statSync(source, { bigint: true });

      const record = {
        ino: String(stats.ino),
        ctimeNs: String(stats.ctimeNs),
        size: String(stats.size),
      };

      const copies = readCopies();
      const last = copies[impId];

      const isUnchanged =
        last?.ino === record.ino && last.ctimeNs === record.ctimeNs && last.size === record.size;

      if (options.isReusable && isUnchanged && existsSync(target)) {
        return;
      }

      mkdirSync(dirname(target), { recursive: true });
      rmSync(`${target}.new`, { force: true });

      await ctx.cloneFile(source, `${target}.new`);

      renameSync(`${target}.new`, target);

      if (options.isReusable) {
        writeCopies({ ...copies, [impId]: record });
      } else {
        freshCopies.add(impId);
      }
    },

    openBackupTree: async (request) => {
      const impIds = new Set<string>();
      const checkpointIds = new Set<string>();
      const imageDigests = new Set<string>();

      for (const imp of request.imps) {
        if (!existsSync(join(backup.tree, BACKUP_TREE.buildDisk(imp.impId)))) {
          continue;
        }

        impIds.add(imp.impId);

        for (const checkpointId of imp.checkpointIds) {
          const isCopied = await createTreeClone(
            ctx.buildCheckpointDisk(imp.impId, checkpointId),
            join(backup.tree, BACKUP_TREE.buildCheckpointDisk(imp.impId, checkpointId)),
          );

          if (isCopied) {
            checkpointIds.add(checkpointId);
          }
        }

        removeUnlisted(
          join(backup.tree, BACKUP_TREE.buildImpDir(imp.impId), 'checkpoints'),
          new Set(imp.checkpointIds.filter((id) => checkpointIds.has(id))),
        );
      }

      for (const digest of request.imageDigests) {
        const source = buildImagePaths(ctx.dataDir, digest);
        const directory = join(backup.tree, BACKUP_TREE.buildImageDir(digest));

        const isCopied = await createTreeClone(source.rootfs, join(directory, 'rootfs.ext4'));

        if (isCopied) {
          copyFileSync(source.config, join(directory, 'config.json'));

          imageDigests.add(digest);
        }
      }

      removeUnlisted(join(backup.tree, 'imps'), impIds);

      removeUnlisted(
        join(backup.tree, 'images'),
        new Set([...imageDigests].map((digest) => basename(BACKUP_TREE.buildImageDir(digest)))),
      );

      const copies = readCopies();

      writeCopies(Object.fromEntries(Object.entries(copies).filter(([id]) => impIds.has(id))));

      // a reflink copy of a running disk would pin the blocks it shares until the next run
      const removeFreshCopies = () => {
        for (const impId of freshCopies) {
          rmSync(join(backup.tree, BACKUP_TREE.buildDisk(impId)), { force: true });
        }

        freshCopies.clear();

        return Promise.resolve();
      };

      return { impIds, checkpointIds, imageDigests, close: removeFreshCopies };
    },
  };
}

function removeUnlisted(directory: string, keep: ReadonlySet<string>): void {
  const names = existsSync(directory) ? readdirSync(directory) : [];

  for (const name of names.filter((entry) => !keep.has(entry))) {
    rmSync(join(directory, name), { recursive: true, force: true });
  }
}
