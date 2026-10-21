import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { printLog } from '../../platform/process/print-log';
import { runChecked } from '../../platform/process/run-command';
import { countOwnerBytes } from './count-owner-bytes';
import type { OwnedFile } from './count-owner-bytes';
import { createXfsBackups } from './create-xfs-backups';
import {
  buildBackupPaths,
  buildImagePaths,
  buildImagesDir,
  buildImpPaths,
  buildImpsDir,
} from './data-layout';
import { readExtents } from './fiemap';
import { readLoopHostFreeBytes } from './loop-backing-file';
import { listFilesUnder, probeHoldingFiles, readDirectoryOrphan } from './orphan-files';
import { printSweep } from './print-sweep';
import { createReflinkClone } from './reflink';
import type {
  DiskSource,
  DroppedStorage,
  LiveStorage,
  OrphanStorage,
  StorageBackend,
  SweepResult,
} from './storage-backend';

const USAGE_DEADLINE_MS = 20_000;
const STAGING_PREFIX = '.new-';

interface OrphanEntry {
  readonly kind: 'imp' | 'image' | 'checkpoint';
  readonly id: string;
  readonly directory: string;
}

interface LeftoverPlan {
  readonly dropped: DroppedStorage[];
  readonly orphans: OrphanEntry[];
}

interface XfsBackendDeps {
  readonly dataDir: string;
  readonly cloneFile?: (source: string, target: string) => Promise<void>;
  readonly reserveFileBytes?: number;
  readonly log?: (message: string) => void;
  readonly readFileExtents?: typeof readExtents;
}

interface OwnedPath {
  readonly owner: string;
  readonly path: string;
}

export function createXfsBackend(deps: XfsBackendDeps): StorageBackend {
  const cloneFile = deps.cloneFile ?? createReflinkClone;
  const log = deps.log ?? printLog;
  const readFileExtents = deps.readFileExtents ?? readExtents;
  const resolveImpPaths = (impId: string) => buildImpPaths(deps.dataDir, impId);

  const buildCheckpointDisk = (impId: string, checkpointId: string): string =>
    join(resolveImpPaths(impId).checkpointsDir, checkpointId, 'disk.ext4');

  const getSourceFile = (source: DiskSource): string => {
    if (source.kind === 'image') {
      return buildImagePaths(deps.dataDir, source.digest).rootfs;
    }

    if (source.kind === 'imp') {
      return resolveImpPaths(source.impId).disk;
    }

    if (source.kind === 'checkpoint') {
      return buildCheckpointDisk(source.impId, source.checkpointId);
    }

    throw new Error('xfs: an empty disk has no source file');
  };

  const createImage = async (digest: string, write: (directory: string) => Promise<void>) => {
    const paths = buildImagePaths(deps.dataDir, digest);
    const staged = join(buildImagesDir(deps.dataDir), `${STAGING_PREFIX}${Bun.randomUUIDv7()}`);

    mkdirSync(staged, { recursive: true });

    try {
      await write(staged);

      if (!existsSync(paths.rootfs)) {
        rmSync(paths.directory, { recursive: true, force: true });
      }

      renameSync(staged, paths.directory);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  };

  const backup = buildBackupPaths(deps.dataDir);

  const planLeftovers = (live: LiveStorage, isOrphans: boolean): LeftoverPlan => {
    const liveDigests = new Set(
      [...live.imageDigests].map((digest) =>
        basename(buildImagePaths(deps.dataDir, digest).directory),
      ),
    );

    const impIds = listEntries(buildImpsDir(deps.dataDir));

    const checkpoints = impIds
      .filter((impId) => live.impIds.has(impId))
      .flatMap((impId) => {
        const directory = resolveImpPaths(impId).checkpointsDir;

        return listEntries(directory).map((id) => ({
          kind: 'checkpoint' as const,
          id,
          directory: join(directory, id),
        }));
      })
      .filter((checkpoint) => !live.checkpointIds.has(checkpoint.id));

    const unknownImages = listEntries(buildImagesDir(deps.dataDir))
      .filter((name) => !name.startsWith('.') && !liveDigests.has(name))
      .map((name) => ({
        kind: 'image' as const,
        id: name,
        directory: join(buildImagesDir(deps.dataDir), name),
      }));

    const unknownImps = impIds
      .filter((impId) => !live.impIds.has(impId))
      .map((impId) => ({
        kind: 'imp' as const,
        id: impId,
        directory: resolveImpPaths(impId).directory,
      }));

    const unknown: OrphanEntry[] = [...unknownImages, ...unknownImps, ...checkpoints];
    const probeDropped = (entry: OrphanEntry) => isOrphans || !probeHoldingFiles(entry.directory);

    return {
      dropped: unknown.filter((entry) => probeDropped(entry)).map((entry) => toStorage(entry)),
      orphans: unknown.filter((entry) => !probeDropped(entry)),
    };
  };

  const readOrphan = (orphan: OrphanEntry): OrphanStorage => {
    const snapshots =
      orphan.kind === 'imp' ? listEntries(resolveImpPaths(orphan.id).checkpointsDir) : [];

    return readDirectoryOrphan(orphan.kind, orphan.id, orphan.directory, snapshots);
  };

  const removeLeftover = (dropped: DroppedStorage, live: LiveStorage): void => {
    if (dropped.kind === 'image') {
      rmSync(join(buildImagesDir(deps.dataDir), dropped.id), { recursive: true, force: true });
    }

    if (dropped.kind === 'imp') {
      rmSync(resolveImpPaths(dropped.id).directory, { recursive: true, force: true });
    }

    if (dropped.kind === 'checkpoint') {
      for (const impId of live.impIds) {
        rmSync(join(resolveImpPaths(impId).checkpointsDir, dropped.id), {
          recursive: true,
          force: true,
        });
      }
    }
  };

  const listImpFiles = (impId: string) => {
    const paths = resolveImpPaths(impId);

    const checkpoints = listEntries(paths.checkpointsDir).map((id) =>
      buildCheckpointDisk(impId, id),
    );

    return [paths.disk, ...checkpoints, paths.memFile, paths.vmstate]
      .filter((path) => existsSync(path))
      .map((path) => ({ owner: `imp:${impId}`, path }));
  };

  // the backup tree's reflink copies hold blocks between runs, so the tree counts as an owner
  const listOtherFiles = () => {
    const images = listEntries(buildImagesDir(deps.dataDir))
      .filter((name) => !name.startsWith('.'))
      .map((name) => ({
        owner: `image:${name}`,
        path: join(buildImagesDir(deps.dataDir), name, 'rootfs.ext4'),
      }));

    const tree = listFilesUnder(backup.tree).map((path) => ({ owner: 'backup', path }));

    return [...images, ...tree].filter((file) => existsSync(file.path));
  };

  const usageState = { resumeImpId: null as string | null };

  const setupReserveFile = async (): Promise<void> => {
    const bytes = deps.reserveFileBytes ?? 0;
    const file = join(deps.dataDir, 'reserve');

    if (bytes === 0 || existsSync(file)) {
      return;
    }

    const stats = statfsSync(deps.dataDir);

    if (stats.bavail * stats.bsize < 2 * bytes) {
      log(`impd: xfs: too little free space for the ${String(bytes)}-byte reserve file`);

      return;
    }

    await runChecked(['fallocate', '-l', String(bytes), `${file}.new`]);

    renameSync(`${file}.new`, file);
  };

  const removeUnnamed = (
    live: LiveStorage,
    options: Readonly<{ isDryRun: boolean; isOrphans: boolean }>,
  ): SweepResult => {
    const plan = planLeftovers(live, options.isOrphans);
    const kept = plan.orphans.map((orphan) => readOrphan(orphan));

    if (!options.isDryRun) {
      for (const leftover of plan.dropped) {
        removeLeftover(leftover, live);
      }
    }

    return { dropped: plan.dropped, kept };
  };

  return {
    kind: 'xfs',
    readWarnings: () => [],
    start: (live) => {
      const imagesDir = buildImagesDir(deps.dataDir);

      for (const name of listEntries(imagesDir).filter((entry) => entry.startsWith('.'))) {
        rmSync(join(imagesDir, name), { recursive: true, force: true });
      }

      const swept = removeUnnamed(live, { isDryRun: false, isOrphans: false });

      printSweep(log, 'impd: storage', swept, 'each');

      return setupReserveFile();
    },
    dropUnnamed: (live, options) => Promise.resolve(removeUnnamed(live, options)),
    resolveImpPaths,

    // sends the files in place, since the move's fence keeps every writer off them
    openMoveSource: (impId, checkpointIds, mode) => {
      if (mode !== 'files') {
        return Promise.reject(new Error('xfs: a move from an XFS host sends files'));
      }

      return Promise.resolve({
        kind: 'files',
        checkpointPaths: checkpointIds.map((checkpointId) =>
          buildCheckpointDisk(impId, checkpointId),
        ),
        diskPath: resolveImpPaths(impId).disk,
        close: () => Promise.resolve(),
      });
    },
    receiveMoveSnapshots: () =>
      Promise.reject(new Error('xfs: only a ZFS host receives ZFS streams')),

    createImage,

    createImageFromImp: (digest, impId, steps) =>
      createImage(digest, async (directory) => {
        await steps.hold(() =>
          cloneFile(resolveImpPaths(impId).disk, join(directory, 'rootfs.ext4')),
        );

        await steps.write(directory);
      }),

    removeImage: (digest) => {
      rmSync(buildImagePaths(deps.dataDir, digest).directory, { recursive: true, force: true });

      return Promise.resolve();
    },

    createImpDisk: async (impId, source) => {
      const disk = resolveImpPaths(impId).disk;

      mkdirSync(dirname(disk), { recursive: true });

      if (source.kind === 'empty') {
        writeFileSync(disk, '');

        return;
      }

      await cloneFile(getSourceFile(source), disk);
    },

    removeImpDisk: (impId) => {
      const paths = resolveImpPaths(impId);

      rmSync(paths.disk, { force: true });
      rmSync(paths.checkpointsDir, { recursive: true, force: true });

      return Promise.resolve();
    },

    createCheckpoint: async (impId, checkpointId) => {
      const disk = buildCheckpointDisk(impId, checkpointId);

      mkdirSync(dirname(disk), { recursive: true });

      try {
        await cloneFile(resolveImpPaths(impId).disk, disk);

        // a reflink clone's blocks count the extents it shares in full, so this is an upper bound
        return statSync(disk).blocks * 512;
      } catch (error) {
        rmSync(dirname(disk), { recursive: true, force: true });
        throw error;
      }
    },

    removeCheckpoint: (impId, checkpointId) => {
      rmSync(dirname(buildCheckpointDisk(impId, checkpointId)), { recursive: true, force: true });

      return Promise.resolve();
    },

    restoreCheckpoint: async (impId, checkpointId, halt) => {
      const disk = resolveImpPaths(impId).disk;
      const staged = `${disk}.new`;

      rmSync(staged, { force: true });

      try {
        await cloneFile(buildCheckpointDisk(impId, checkpointId), staged);

        const halted = await halt();

        renameSync(staged, disk);

        return halted;
      } finally {
        rmSync(staged, { force: true });
      }
    },

    ...createXfsBackups({
      dataDir: deps.dataDir,
      cloneFile,
      resolveImpPaths,
      buildCheckpointDisk,
    }),

    stop: () => Promise.resolve(),

    measureUsage: async (imps) => {
      const deadline = Date.now() + USAGE_DEADLINE_MS;
      const owned: OwnedFile[] = [];
      const ids = imps.map((imp) => imp.impId);
      const start = Math.max(0, ids.indexOf(usageState.resumeImpId ?? ''));
      const ordered = [...ids.slice(start), ...ids.slice(0, start)];

      const readAll = async (files: readonly OwnedPath[]) => {
        for (const file of files) {
          const read = await readOwnedExtents(readFileExtents, file.path, deadline);

          owned.push({ owner: file.owner, extents: read.extents });

          if (!read.isComplete) {
            return false;
          }
        }

        return true;
      };

      const finished: string[] = [];

      const isOthersRead = await readAll(listOtherFiles());

      for (const impId of isOthersRead ? ordered : []) {
        if (!(await readAll(listImpFiles(impId)))) {
          break;
        }

        finished.push(impId);
      }

      const isPartial = finished.length < ordered.length;

      usageState.resumeImpId = isPartial ? (ordered[finished.length] ?? null) : null;

      const totals = countOwnerBytes(owned);

      const report = new Map(
        finished.map((impId) => {
          const total = totals.get(`imp:${impId}`) ?? { exclusiveBytes: 0, sharedBytes: 0 };

          return [impId, { ...total, isUpperBound: false }];
        }),
      );

      return { imps: report, isPartial };
    },

    readUsage: () => {
      const stats = statfsSync(deps.dataDir);
      const available = stats.bavail * stats.bsize;

      // a loop-mounted XFS file can grow only as far as its host directory lets it
      const hostFree = readLoopHostFreeBytes(deps.dataDir) ?? available;

      return Promise.resolve({
        usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
        availableBytes: Math.min(available, hostFree),
      });
    },
  };
}

// readdir order differs between filesystems, so a sweep sorts to list the same order on each
function listEntries(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).toSorted() : [];
}

function toStorage(entry: OrphanEntry): DroppedStorage {
  return { kind: entry.kind, id: entry.id };
}

async function readOwnedExtents(
  readFileExtents: typeof readExtents,
  path: string,
  deadline: number,
) {
  try {
    return await readFileExtents(path, deadline);
  } catch (error) {
    if (existsSync(path)) {
      throw error;
    }

    return { extents: [], isComplete: true };
  }
}
