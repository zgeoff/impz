import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildKeyedMutex } from '../../../platform/process/keyed-mutex';
import { readMounts as readHostMounts } from '../../../platform/process/mounts';
import { printLog } from '../../../platform/process/print-log';
import { runCommand } from '../../../platform/process/run-command';
import type { CommandRunner } from '../../../platform/process/run-command';
import { createStreamRunner } from '../../../platform/process/run-stream';
import type { StreamRunner } from '../../../platform/process/run-stream';
import { buildImagePaths, buildImpPaths, buildSnapshotPaths, toDigestHex } from '../data-layout';
import { printSweep } from '../print-sweep';
import type { DiskSource, StorageBackend } from '../storage-backend';
import { checkZfsVersions } from './check-zfs-versions';
import { createZfsBackups } from './create-zfs-backups';
import { createZfsCheckpoints } from './create-zfs-checkpoints';
import { createZfsMoves } from './create-zfs-moves';
import { createZfsReclaim } from './create-zfs-reclaim';
import { createZfsSweep } from './create-zfs-sweep';
import { createZfsUsage } from './create-zfs-usage';
import {
  createZfsCommands,
  getCheckpointSnapshot,
  getChildId,
  listCheckpointSnapshots,
  listChildren,
  parseZfsMounts,
} from './zfs-commands';

const BLOCK_RECORDSIZE = '16K';

// ZFS needs free space to run a destroy on a full pool, so this much is held back;
// `zfs set refreservation=none <root>/reserve` frees it.
const RESERVE_SIZE = '1G';
const ROOTFS_FILE = 'rootfs.ext4';

export interface ZfsBackendDeps {
  readonly dataDir: string;
  readonly root: string;
  readonly run?: CommandRunner;
  readonly streams?: StreamRunner;
  readonly readMounts?: () => string;
  readonly readModuleVersion?: () => string | null;
  readonly log?: (message: string) => void;
  readonly isUiomoveBugAllowed?: boolean;
  readonly isKernelOopsed?: () => boolean;
}

export interface ZfsBackend extends StorageBackend {
  readonly waitForReclaim: () => Promise<void>;
}

export function createZfsBackend(deps: ZfsBackendDeps): ZfsBackend {
  const zfs = createZfsCommands(deps.run ?? runCommand);
  const streams = deps.streams ?? createStreamRunner();

  const heldSnapshots = new Set<string>();

  const log = deps.log ?? printLog;
  const readMounts = deps.readMounts ?? readHostMounts;
  const readModuleVersion = deps.readModuleVersion ?? readZfsModuleVersion;
  const isKernelOopsed = deps.isKernelOopsed ?? (() => false);

  // Snapshots of a frozen guest take a lane of their own, so a frozen guest never waits on a
  // reclaim or a restore.
  const mutex = buildKeyedMutex();
  const runSerial = <T>(task: () => Promise<T>) => mutex.runExclusive('zfs', task);
  const runSnapshot = <T>(task: () => Promise<T>) => mutex.runExclusive('snapshot', task);
  const host = { warnings: [] as string[] };

  const datasets = {
    mem: `${deps.root}/mem`,
    disks: `${deps.root}/disks`,
    images: `${deps.root}/images`,
    retired: `${deps.root}/retired`,
    staging: `${deps.root}/staging`,
    reserve: `${deps.root}/reserve`,
  };

  const buildDiskName = (impId: string) => `${datasets.disks}/${impId}`;
  const buildImageName = (digest: string) => `${datasets.images}/${toDigestHex(digest)}`;
  const buildRestoreName = (impId: string) => `${datasets.staging}/restore-${impId}`;

  const buildDiskDir = (impId: string) =>
    join(buildImpPaths(deps.dataDir, impId).directory, 'disk');

  const buildImageDir = (digest: string) => buildImagePaths(deps.dataDir, digest).directory;

  const buildStagingDir = (name: string) =>
    join(deps.dataDir, 'staging', name.slice(datasets.staging.length + 1));

  const resolveImpPaths = (impId: string) => ({
    ...buildImpPaths(deps.dataDir, impId),
    disk: join(buildDiskDir(impId), ROOTFS_FILE),
    ...buildSnapshotPaths(join(deps.dataDir, 'mem', impId)),
  });

  const listAll = () => zfs.list(deps.root);

  const setupMount = async (name: string, directory: string, isReadOnly = false): Promise<void> => {
    const mounted = parseZfsMounts(readMounts()).get(directory);

    if (mounted === name) {
      return;
    }

    if (mounted !== undefined) {
      throw new Error(`zfs: ${directory} has ${mounted} mounted, not ${name}`);
    }

    mkdirSync(directory, { recursive: true });

    await zfs.mount(name, directory, { isReadOnly });
  };

  const removeMount = async (directory: string): Promise<void> => {
    if (parseZfsMounts(readMounts()).has(directory)) {
      await zfs.unmount(directory);
    }
  };

  const removeDataset = async (name: string): Promise<void> => {
    const retired = `${datasets.retired}/${Bun.randomUUIDv7()}`;

    await zfs.rename(name, retired);

    log(`impd: zfs: retired ${name} as ${retired}`);
  };

  const reclaim = createZfsReclaim({
    zfs,
    datasets,
    runSerial,
    listAll,
    log,
    isKernelOopsed,
  });

  const readOrigin = async (source: DiskSource): Promise<string> => {
    if (source.kind === 'image') {
      return `${buildImageName(source.digest)}@base`;
    }

    if (source.kind === 'imp') {
      throw new Error('zfs: a fork of a live disk takes its own snapshot');
    }

    if (source.kind === 'empty') {
      throw new Error('zfs: an empty disk has no origin');
    }

    const entries = await listAll();

    return getCheckpointSnapshot(entries, source.checkpointId);
  };

  const createMissingDatasets = async (): Promise<void> => {
    const entries = await listAll();

    const existing = new Set(entries.map((entry) => entry.name));

    const blocks = { recordsize: BLOCK_RECORDSIZE };

    const wanted: [string, Record<string, string>][] = [
      [datasets.mem, {}],
      [datasets.disks, blocks],
      [datasets.images, blocks],
      [datasets.staging, blocks],
      [datasets.retired, {}],
      [datasets.reserve, { refreservation: RESERVE_SIZE }],
    ];

    for (const [name, properties] of wanted) {
      if (!existing.has(name)) {
        await zfs.create(name, properties);
      }
    }
  };

  const resolveStaging = async (): Promise<void> => {
    const entries = await listAll();

    const names = new Set(entries.map((entry) => entry.name));

    // Newest first, because ZFS destroys a clone only before its origin.
    for (const staged of listChildren(entries, datasets.staging).toReversed()) {
      const impId = staged.name.slice(buildRestoreName('').length);

      if (staged.name.startsWith(buildRestoreName('')) && !names.has(buildDiskName(impId))) {
        await zfs.rename(staged.name, buildDiskName(impId));

        log(`impd: zfs: finished the restore of ${impId} that a crash cut short`);
        continue;
      }

      for (const [directory, name] of parseZfsMounts(readMounts())) {
        if (name === staged.name) {
          await zfs.unmount(directory);
        }
      }

      await zfs.destroyRecursive(staged.name);

      log(`impd: zfs: destroyed ${staged.name}, a clone or build a crash cut short`);
      removeMountDir(buildStagingDir(staged.name));
    }
  };

  const sweep = createZfsSweep({
    zfs,
    dataDir: deps.dataDir,
    root: deps.root,
    datasets,
    heldSnapshots,
    listAll,
    readMounts,
    removeMount,
    removeDataset,
    buildDiskDir,
    buildImageDir,
  });

  const setupMounts = async (): Promise<void> => {
    const entries = await listAll();

    for (const disk of listChildren(entries, datasets.disks)) {
      await setupMount(disk.name, buildDiskDir(getChildId(disk.name, datasets.disks)));
    }

    for (const image of listChildren(entries, datasets.images)) {
      await setupMount(image.name, buildImageDir(getChildId(image.name, datasets.images)));
    }
  };

  const createImageFromStaging = async (
    digest: string,
    staged: string,
    write: (directory: string) => Promise<void>,
  ): Promise<void> => {
    const directory = buildStagingDir(staged);

    try {
      await runSerial(() => setupMount(staged, directory));
      await write(directory);
    } catch (error) {
      await runSerial(async () => {
        await removeMount(directory);

        await zfs.destroy(staged);
      });

      removeMountDir(directory);
      throw error;
    }

    await runSerial(async () => {
      const name = buildImageName(digest);

      await removeMount(directory);

      removeMountDir(directory);

      // ZFS moves a snapshot with its dataset's rename, so no image is ever without its `@base`.
      await zfs.snapshot(`${staged}@base`);
      await zfs.rename(staged, name);

      await setupMount(name, buildImageDir(digest));
    });
  };

  return {
    kind: 'zfs',

    start: (live) =>
      runSerial(async () => {
        await checkZfsVersions({
          zfs,
          readModuleVersion,
          log,
          isUiomoveBugAllowed: deps.isUiomoveBugAllowed,
          host,
        });

        if (parseZfsMounts(readMounts()).get(deps.dataDir) !== deps.root) {
          throw new Error(
            `zfs: ${deps.root} is not mounted on ${deps.dataDir} (host/scripts/setup-storage.sh mounts it)`,
          );
        }

        await createMissingDatasets();
        await setupMount(datasets.mem, join(deps.dataDir, 'mem'));
        await resolveStaging();

        const swept = await sweep.removeLeftovers(live, { isDryRun: false, isOrphans: false });

        printSweep(log, 'impd: storage', swept, 'each');

        await reclaim.runReclaim(reclaim.runReclaimStep);

        await setupMounts();
      }),

    dropUnnamed: async (live, options) => {
      const swept = await runSerial(() => sweep.removeLeftovers(live, options));

      if (!options.isDryRun) {
        reclaim.startReclaim();
      }

      return swept;
    },

    resolveImpPaths,
    ...createZfsMoves({
      zfs,
      streams,
      datasets,
      heldSnapshots,
      runSerial,
      runSnapshot,
      listAll,
      setupMount,
      removeMount,
      removeMountDir,
      buildDiskName,
      buildDiskDir,
      buildStagingDir,
      rootfsFile: ROOTFS_FILE,
    }),

    createImage: async (digest, write) => {
      const staged = `${datasets.staging}/image-${Bun.randomUUIDv7()}`;

      await runSerial(() => zfs.create(staged));
      await createImageFromStaging(digest, staged, write);
    },

    createImageFromImp: async (digest, impId, steps) => {
      const staged = `${datasets.staging}/image-${Bun.randomUUIDv7()}`;
      const snapshot = `${buildDiskName(impId)}@fork-${Bun.randomUUIDv7()}`;

      await steps.hold(() =>
        runSnapshot(async () => {
          await zfs.snapshot(snapshot);

          try {
            await zfs.clone(snapshot, staged);
          } finally {
            await zfs.destroyDeferred(snapshot);
          }
        }),
      );

      await createImageFromStaging(digest, staged, steps.write);
    },

    removeImage: async (digest) => {
      await runSerial(async () => {
        const name = buildImageName(digest);

        const entries = await listAll();

        if (!entries.some((entry) => entry.name === name)) {
          return;
        }

        await removeMount(buildImageDir(digest));

        removeMountDir(buildImageDir(digest));

        if (entries.some((entry) => entry.name === `${name}@base`)) {
          await zfs.destroyDeferred(`${name}@base`);
        }

        await removeDataset(name);
      });

      reclaim.startReclaim();
    },

    createImpDisk: async (impId, source) => {
      const target = buildDiskName(impId);

      if (source.kind === 'imp') {
        const snapshot = `${buildDiskName(source.impId)}@fork-${Bun.randomUUIDv7()}`;

        await runSnapshot(async () => {
          await zfs.snapshot(snapshot);

          try {
            await zfs.clone(snapshot, target);
          } finally {
            // ZFS keeps a snapshot marked for deferred destroy while its clone needs it.
            await zfs.destroyDeferred(snapshot);
          }

          await setupMount(target, buildDiskDir(impId));
        });

        return;
      }

      if (source.kind === 'empty') {
        await runSerial(async () => {
          await zfs.create(target);

          await setupMount(target, buildDiskDir(impId));
        });

        writeFileSync(join(buildDiskDir(impId), ROOTFS_FILE), '');

        return;
      }

      // A ZFS promote can move a checkpoint's snapshot to another dataset, so the lookup is serial.
      await runSerial(async () => {
        const origin = await readOrigin(source);

        await zfs.clone(origin, target);

        await setupMount(target, buildDiskDir(impId));
      });
    },

    removeImpDisk: async (impId, checkpointIds) => {
      await runSerial(async () => {
        const entries = await listAll();

        const names = new Set(entries.map((entry) => entry.name));

        for (const checkpointId of checkpointIds) {
          for (const snapshot of listCheckpointSnapshots(entries, checkpointId)) {
            if (!snapshot.deferDestroy) {
              await zfs.destroyDeferred(snapshot.name);
            }
          }
        }

        await removeMount(buildDiskDir(impId));

        if (names.has(buildRestoreName(impId))) {
          await zfs.destroy(buildRestoreName(impId));
        }

        if (names.has(buildDiskName(impId))) {
          await removeDataset(buildDiskName(impId));
        }
      });

      reclaim.startReclaim();
    },

    ...createZfsCheckpoints({
      zfs,
      runSerial,
      runSnapshot,
      listAll,
      log,
      setupMount,
      removeMount,
      removeDataset,
      startReclaim: reclaim.startReclaim,
      buildDiskName,
      buildDiskDir,
      buildRestoreName,
    }),

    ...createZfsBackups({
      zfs,
      dataDir: deps.dataDir,
      datasets,
      runSerial,
      runSnapshot,
      listAll,
      log,
      readMounts,
      setupMount,
      removeMount,
      startReclaim: reclaim.startReclaim,
      buildDiskName,
      buildImageName,
    }),

    waitForReclaim: reclaim.waitForReclaim,
    stop: reclaim.waitForReclaim,

    ...createZfsUsage({
      zfs,
      root: deps.root,
      datasets,
      buildDiskName,
      buildImageName,
      resolveImpPaths,
    }),

    readUsage: async () => {
      const usage = await zfs.readUsage(deps.root);

      return { usedBytes: usage.used, availableBytes: usage.available };
    },

    readWarnings: () => host.warnings,
  };
}

function readZfsModuleVersion(): string | null {
  try {
    return readFileSync('/sys/module/zfs/version', 'utf8').trim();
  } catch {
    return null;
  }
}

// A recursive removal would delete the files of a dataset still mounted there.
function removeMountDir(directory: string): void {
  if (existsSync(directory)) {
    rmdirSync(directory);
  }
}
