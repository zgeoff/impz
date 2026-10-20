import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKeyedMutex } from '../../../platform/process/keyed-mutex';
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
  findCheckpointSnapshot,
  listCheckpointSnapshots,
  listChildren,
  parseZfsMounts,
  readChildId,
} from './zfs-commands';

// ARC and record sizes are set where the datasets are made (deploy/
// bootstrap.sh); these are the defaults impd uses for what it creates itself.
const BLOCK_RECORDSIZE = '16K';

// held back, so a destroy still has room to run on a full pool: free it with
// `zfs set refreservation=none <root>/reserve`
const RESERVE_SIZE = '1G';

// the file in each disk and image dataset; a disk is a clone of an image
const ROOTFS_FILE = 'rootfs.ext4';

export interface ZfsBackendDeps {
  readonly dataDir: string;

  // the dataset mounted on dataDir, such as tank/imp
  readonly root: string;
  readonly run?: CommandRunner;

  // `zfs send` and `zfs recv` for moves
  readonly streams?: StreamRunner;

  // /proc/self/mounts and /sys/module/zfs/version by default
  readonly readMounts?: () => string;
  readonly readModuleVersion?: () => string | null;
  readonly log?: (message: string) => void;

  // IMP_ZFS_ALLOW_UIOMOVE_BUG=1: start on a module with the zfs_uiomove bug,
  // with a warning; start refuses one by default
  readonly isUiomoveBugAllowed?: boolean;

  // whether the host's kernel has oopsed (imps/kernel-oops-watch.ts); never
  // by default
  readonly isKernelOopsed?: () => boolean;
}

// Each imp disk is a dataset holding one file, a checkpoint is a snapshot of
// it and a fork is a clone (docs/architecture/storage/storage.md#zfs).
export interface ZfsBackend extends StorageBackend {
  // resolves once the reclaim that changes start in the background is done
  readonly waitForReclaim: () => Promise<void>;
}

export function createZfsBackend(deps: ZfsBackendDeps): ZfsBackend {
  const zfs = createZfsCommands(deps.run ?? runCommand);
  const streams = deps.streams ?? createStreamRunner();

  // a move's snapshots while it sends: no GC drops them
  const heldSnapshots = new Set<string>();

  const log = deps.log ?? printLog;
  const readMounts = deps.readMounts ?? readHostMounts;
  const readModuleVersion = deps.readModuleVersion ?? readZfsModuleVersion;
  const isKernelOopsed = deps.isKernelOopsed ?? (() => false);

  // Dataset changes run one at a time: a reclaim must never see a restore
  // half done. Snapshots of a frozen guest have a lane of their own and never
  // wait for one; they touch no dataset a reclaim or restore moves.
  const mutex = createKeyedMutex();
  const runSerial = <T>(task: () => Promise<T>) => mutex.runExclusive('zfs', task);
  const runSnapshot = <T>(task: () => Promise<T>) => mutex.runExclusive('snapshot', task);

  // what /health tells an operator about this host's ZFS, set at start
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
  const buildDiskDir = (impId: string) => join(buildImpPaths(deps.dataDir, impId).dir, 'disk');
  const buildImageDir = (digest: string) => buildImagePaths(deps.dataDir, digest).dir;

  const buildStagingDir = (name: string) =>
    join(deps.dataDir, 'staging', name.slice(datasets.staging.length + 1));

  const resolveImpPaths = (impId: string) => ({
    ...buildImpPaths(deps.dataDir, impId),
    disk: join(buildDiskDir(impId), ROOTFS_FILE),
    ...buildSnapshotPaths(join(deps.dataDir, 'mem', impId)),
  });

  const listAll = () => zfs.list(deps.root);

  const setupMount = async (name: string, dir: string, isReadOnly = false): Promise<void> => {
    const mounted = parseZfsMounts(readMounts()).get(dir);

    if (mounted === name) {
      return;
    }

    if (mounted !== undefined) {
      throw new Error(`zfs: ${dir} has ${mounted} mounted, not ${name}`);
    }

    mkdirSync(dir, { recursive: true });

    await zfs.mount(name, dir, { isReadOnly });
  };

  const removeMount = async (dir: string): Promise<void> => {
    if (parseZfsMounts(readMounts()).has(dir)) {
      await zfs.unmount(dir);
    }
  };

  // an old disk or image leaves the namespace at once; runReclaim frees it once
  // no checkpoint or clone needs its blocks
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

  const findOrigin = async (source: DiskSource): Promise<string> => {
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

    return findCheckpointSnapshot(entries, source.checkpointId);
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

  // A restore clones the checkpoint into staging, then renames it over the
  // disk. With the disk gone, the crash came between the two renames.
  const resolveStaging = async (): Promise<void> => {
    const entries = await listAll();

    const names = new Set(entries.map((entry) => entry.name));

    // newest first: a move's clones go before their origins
    for (const staged of listChildren(entries, datasets.staging).toReversed()) {
      const impId = staged.name.slice(buildRestoreName('').length);

      if (staged.name.startsWith(buildRestoreName('')) && !names.has(buildDiskName(impId))) {
        await zfs.rename(staged.name, buildDiskName(impId));

        log(`impd: zfs: finished the restore of ${impId} that a crash cut short`);
        continue;
      }

      // a backup run's clones are mounted in the backup tree
      for (const [dir, name] of parseZfsMounts(readMounts())) {
        if (name === staged.name) {
          await zfs.unmount(dir);
        }
      }

      // a build cut short after its `@base`, before its rename, and a move's
      // received datasets carry snapshots
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
      await setupMount(disk.name, buildDiskDir(readChildId(disk.name, datasets.disks)));
    }

    for (const image of listChildren(entries, datasets.images)) {
      await setupMount(image.name, buildImageDir(readChildId(image.name, datasets.images)));
    }
  };

  // Mounts a staged image dataset for `write`, then renames it into place
  // with its @base snapshot; a failed write destroys it.
  const createImageFromStaging = async (
    digest: string,
    staged: string,
    write: (dir: string) => Promise<void>,
  ): Promise<void> => {
    const dir = buildStagingDir(staged);

    try {
      await runSerial(() => setupMount(staged, dir));
      await write(dir);
    } catch (error) {
      await runSerial(async () => {
        await removeMount(dir);

        await zfs.destroy(staged);
      });

      removeMountDir(dir);
      throw error;
    }

    await runSerial(async () => {
      const name = buildImageName(digest);

      await removeMount(dir);

      removeMountDir(dir);

      // the snapshot moves with the rename, so no image is ever without one
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

    // The fork of a live disk, as createImpDisk makes one, in staging: the
    // image's origin is the imp's disk until a reclaim promotes it.
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

      // The caller has a live source frozen, so its fork takes the snapshot
      // lane and never waits for a reclaim. Its new clone is not retired, and
      // nothing else names it yet.
      if (source.kind === 'imp') {
        const snapshot = `${buildDiskName(source.impId)}@fork-${Bun.randomUUIDv7()}`;

        await runSnapshot(async () => {
          await zfs.snapshot(snapshot);

          try {
            await zfs.clone(snapshot, target);
          } finally {
            // ZFS keeps a fork snapshot while the clone needs it
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

      // a promote can move a checkpoint's snapshot, so the lookup is serial
      await runSerial(async () => {
        const origin = await findOrigin(source);

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

    ...createZfsUsage({ zfs, root: deps.root, datasets, buildDiskName, resolveImpPaths }),

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

// Not recursive: a dataset still mounted there would lose its files.
function removeMountDir(dir: string): void {
  if (existsSync(dir)) {
    rmdirSync(dir);
  }
}
