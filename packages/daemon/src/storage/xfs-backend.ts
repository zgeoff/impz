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
import { printLog } from '../process/print-log';
import { runChecked } from '../process/run-command';
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

// a usage pass stops here and reports what it read (fiemap.ts)
const USAGE_DEADLINE_MS = 20_000;

// an image directory being written, renamed into place once complete; a
// hidden name, as image-service's `.build-` work directories
const STAGING_PREFIX = '.new-';

// what no row names, and the directory that holds it
interface OrphanEntry {
  readonly kind: 'imp' | 'image' | 'checkpoint';
  readonly id: string;
  readonly directory: string;
}

// what a sweep removes, and the orphans it keeps
interface LeftoverPlan {
  readonly dropped: DroppedStorage[];
  readonly orphans: OrphanEntry[];
}

interface XfsBackendDeps {
  readonly dataDir: string;

  // a reflink clone by default; tests on a non-XFS tmpdir copy instead
  readonly cloneFile?: (source: string, target: string) => Promise<void>;

  // Space start allocates to <dataDir>/reserve, so a destroy still runs on a
  // full filesystem; removing the file frees it. None by default.
  readonly reserveFileBytes?: number;
  readonly log?: (message: string) => void;

  // FIEMAP by default; tests cut a pass short with their own
  readonly readFileExtents?: typeof readExtents;
}

interface OwnedPath {
  readonly owner: string;
  readonly path: string;
}

// Every disk, checkpoint and fork is a reflink clone of another file
// (docs/architecture/storage/storage.md).
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

      // impd before the storage backends wrote config.json first, so a
      // crash could leave the directory with no rootfs
      if (!existsSync(paths.rootfs)) {
        rmSync(paths.directory, { recursive: true, force: true });
      }

      renameSync(staged, paths.directory);
    } finally {
      rmSync(staged, { recursive: true, force: true });
    }
  };

  const backup = buildBackupPaths(deps.dataDir);

  // What the database does not name: a crash leftover goes, an orphan stays
  // unless `isOrphans`. A lost database would make every imp an orphan
  // (docs/architecture/storage/disk-space.md#the-sweep).
  const planLeftovers = (live: LiveStorage, isOrphans: boolean): LeftoverPlan => {
    const liveDigests = new Set(
      [...live.imageDigests].map((digest) =>
        basename(buildImagePaths(deps.dataDir, digest).directory),
      ),
    );

    const impIds = listEntries(buildImpsDir(deps.dataDir));

    // a named imp's checkpoint with no row is an orphan: an older database
    // lacks the newer rows
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

    // hidden entries are image builds in flight, which only start drops
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

    // only a directory with no file in it is provably nothing; anything
    // else may be what an imp needs to come back
    const unknown: OrphanEntry[] = [...unknownImages, ...unknownImps, ...checkpoints];
    const probeDropped = (entry: OrphanEntry) => isOrphans || !probeHoldingFiles(entry.directory);

    return {
      dropped: unknown.filter((entry) => probeDropped(entry)).map((entry) => toStorage(entry)),
      orphans: unknown.filter((entry) => !probeDropped(entry)),
    };
  };

  // the size, age and checkpoints of an orphan, for the log and `impz gc`
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

  // Every file that holds disk blocks, with whoever removing it frees them.
  // The backup tree's reflinks hold blocks between runs, so it is an owner.
  const listImpFiles = (impId: string) => {
    const paths = resolveImpPaths(impId);

    const checkpoints = listEntries(paths.checkpointsDir).map((id) =>
      buildCheckpointDisk(impId, id),
    );

    return [paths.disk, ...checkpoints, paths.memFile, paths.vmstate]
      .filter((path) => existsSync(path))
      .map((path) => ({ owner: `imp:${impId}`, path }));
  };

  // the owners besides imps; the backup tree's reflinks hold blocks between
  // runs, so it is one
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

  // the imp a pass cut short stopped at; the next pass starts there
  const usageState = { resumeImpId: null as string | null };

  // made once, and again at a start after someone removed it to free space,
  // when twice its size is free
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

    // an image build that a crash cut short leaves its staging dir
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

    // the files themselves: the fence keeps every writer off them
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

        // allocated bytes of the clone; the extents it shares with the imp
        // disk count in full, so this is the most it can cost, not its cost
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
        // gone after the swap; a clone or halt that failed leaves it behind
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

    // The images and the backup tree first, since every imp's shared bytes
    // need them; then the imps, from where the last pass stopped. An imp
    // the pass did not finish is left out, and the cache keeps its last count.
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

// sorted, so a sweep lists the same order on every filesystem
function listEntries(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).toSorted() : [];
}

// a kind and id alone, without the directory
function toStorage(entry: OrphanEntry): DroppedStorage {
  return { kind: entry.kind, id: entry.id };
}

// a file removed since the listing holds nothing
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
