import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildImpPaths, buildImpsDir, toDigestHex } from '../data-layout';
import { probeHoldingFiles, readDirectoryOrphan } from '../orphan-files';
import type { DroppedStorage, LiveStorage, OrphanStorage, SweepResult } from '../storage-backend';
import {
  CHECKPOINT_SNAPSHOT,
  getChildId,
  getSnapshotId,
  listChildren,
  parseZfsMounts,
} from './zfs-commands';
import type { ZfsCommands, ZfsEntry } from './zfs-commands';

// what the ZFS backend lends its sweep: its commands, its held snapshots, the
// names of its datasets and their mounts, and its retire
interface ZfsSweepContext {
  readonly zfs: ZfsCommands;
  readonly dataDir: string;
  readonly root: string;
  readonly datasets: { readonly disks: string; readonly images: string };
  readonly heldSnapshots: ReadonlySet<string>;
  readonly listAll: () => Promise<ZfsEntry[]>;
  readonly readMounts: () => string;
  readonly removeMount: (directory: string) => Promise<void>;
  readonly removeDataset: (name: string) => Promise<void>;
  readonly buildDiskDir: (impId: string) => string;
  readonly buildImageDir: (digest: string) => string;
}

const FORK_SNAPSHOT = /@fork-[^@]+$/u;

// `@bk-<run>-<imp>`: a backup run's copy of a disk, gone once the run ends
const BACKUP_SNAPSHOT = /@bk-[^@]+$/u;

// `@mv-<move>`: a move's copy of a stopped disk, gone once the move ends
const MOVE_SNAPSHOT = /@mv-[^@]+$/u;

// an `imps/<id>` or `mem/<id>` with files and no row, kept with no disk
interface OrphanDir {
  readonly kind: 'imp' | 'memory';
  readonly id: string;
  readonly directory: string;
}

// what removeLeftovers removes, in this order, and the orphans it keeps
interface LeftoverPlan {
  readonly snapshots: readonly ZfsEntry[];
  readonly disks: readonly ZfsEntry[];
  readonly images: readonly ZfsEntry[];
  readonly impDirs: readonly string[];
  readonly memDirs: readonly string[];
  readonly orphans: readonly ZfsEntry[];
  readonly orphanCheckpoints: readonly ZfsEntry[];
  readonly orphanDirs: readonly OrphanDir[];
}

// The ZFS backend's sweep of what the database does not name, at start and
// for `impz gc`
export function createZfsSweep(ctx: ZfsSweepContext) {
  // What the database does not name: a crash leftover goes, an orphan stays
  // with its snapshots unless `isOrphans`. A lost database would make every
  // disk an orphan (docs/architecture/storage/disk-space.md#the-sweep).
  const planLeftovers = (
    entries: readonly ZfsEntry[],
    live: LiveStorage,
    isOrphans: boolean,
  ): LeftoverPlan => {
    const liveDigests = new Set([...live.imageDigests].map((digest) => toDigestHex(digest)));

    const unknownDisks = listChildren(entries, ctx.datasets.disks).filter(
      (disk) => !live.impIds.has(getChildId(disk.name, ctx.datasets.disks)),
    );

    const unknownImages = listChildren(entries, ctx.datasets.images).filter(
      (image) => !liveDigests.has(getChildId(image.name, ctx.datasets.images)),
    );

    // every image, too: one with no `@base` may be a build cut short, but
    // only a `staging/` name proves that, and start settles those
    const orphans = [...unknownDisks, ...unknownImages];

    const orphanNames = new Set(orphans.map((orphan) => orphan.name));

    const isLiveCheckpoint = (snapshot: ZfsEntry) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name) &&
      live.checkpointIds.has(getSnapshotId(snapshot.name));

    // An orphan's snapshots go only with it, before the retire, so the
    // reclaim can free it; its `@base` goes with the image.
    const isOnOrphan = (snapshot: ZfsEntry) => orphanNames.has(getSnapshotDataset(snapshot.name));

    // A checkpoint with no row is an orphan wherever it is, on a named disk or
    // in `retired/`: an older database lacks the newer rows. A fork, backup or
    // move snapshot elsewhere is impd's own, and never outlives its operation.
    const isOrphanCheckpoint = (snapshot: ZfsEntry) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name) && !isLiveCheckpoint(snapshot);

    const isDead = (snapshot: ZfsEntry) => {
      if (isOnOrphan(snapshot)) {
        return isOrphans && !snapshot.name.endsWith('@base') && !isLiveCheckpoint(snapshot);
      }

      return (
        FORK_SNAPSHOT.test(snapshot.name) ||
        BACKUP_SNAPSHOT.test(snapshot.name) ||
        (MOVE_SNAPSHOT.test(snapshot.name) && !ctx.heldSnapshots.has(snapshot.name)) ||
        (isOrphans && isOrphanCheckpoint(snapshot))
      );
    };

    const unmarked = entries.filter((entry) => entry.type === 'snapshot' && !entry.deferDestroy);
    const snapshots = unmarked.filter((entry) => isDead(entry));

    const orphanCheckpoints = isOrphans
      ? []
      : unmarked.filter((entry) => !isOnOrphan(entry) && isOrphanCheckpoint(entry));

    // A directory with no row goes with a kept disk. With no disk, only an
    // empty one is provably nothing; one with files is an orphan.
    const keptDisks = isOrphans ? [] : unknownDisks;

    const keptImpIds = new Set(keptDisks.map((disk) => getChildId(disk.name, ctx.datasets.disks)));

    const listUnknownDirs = (kind: OrphanDir['kind'], parent: string): OrphanDir[] =>
      (existsSync(parent) ? readdirSync(parent).toSorted() : [])
        .filter((id) => !live.impIds.has(id) && !keptImpIds.has(id))
        .map((id) => ({ kind, id, directory: join(parent, id) }));

    const unknownDirs = [
      ...listUnknownDirs('imp', buildImpsDir(ctx.dataDir)),
      ...listUnknownDirs('memory', join(ctx.dataDir, 'mem')),
    ];

    const probeDirDropped = (entry: OrphanDir) => isOrphans || !probeHoldingFiles(entry.directory);
    const droppedDirs = unknownDirs.filter((entry) => probeDirDropped(entry));

    return {
      snapshots,
      disks: isOrphans ? unknownDisks : [],
      images: isOrphans ? unknownImages : [],
      impDirs: droppedDirs.filter((entry) => entry.kind === 'imp').map((entry) => entry.id),
      memDirs: droppedDirs.filter((entry) => entry.kind === 'memory').map((entry) => entry.id),
      orphans: isOrphans ? [] : orphans,
      orphanCheckpoints,
      orphanDirs: unknownDirs.filter((entry) => !probeDirDropped(entry)),
    };
  };

  const toDropped = (plan: LeftoverPlan): DroppedStorage[] => [
    ...plan.snapshots.map((snapshot) =>
      CHECKPOINT_SNAPSHOT.test(snapshot.name)
        ? { kind: 'checkpoint' as const, id: getSnapshotId(snapshot.name) }
        : { kind: 'snapshot' as const, id: snapshot.name },
    ),
    ...plan.images.map((image) => ({
      kind: 'image' as const,
      id: getChildId(image.name, ctx.datasets.images),
    })),
    ...[
      ...new Set([
        ...plan.disks.map((disk) => getChildId(disk.name, ctx.datasets.disks)),
        ...plan.impDirs,
      ]),
    ].map((impId) => ({ kind: 'imp' as const, id: impId })),
    ...plan.memDirs.map((impId) => ({ kind: 'memory' as const, id: impId })),
  ];

  // the size, age and snapshots of each orphan, for the log and `impz gc`
  const readOrphans = async (
    entries: readonly ZfsEntry[],
    plan: LeftoverPlan,
  ): Promise<OrphanStorage[]> => {
    const dirs = plan.orphanDirs.map((entry) =>
      readDirectoryOrphan(entry.kind, entry.id, entry.directory, []),
    );

    if (plan.orphans.length === 0 && plan.orphanCheckpoints.length === 0) {
      return dirs;
    }

    const listed = await ctx.zfs.listSpace(ctx.root);

    const space = new Map(listed.map((entry) => [entry.name, entry]));

    const datasetOrphans = plan.orphans.map((orphan): OrphanStorage => {
      const isDisk = orphan.name.startsWith(`${ctx.datasets.disks}/`);
      const parent = isDisk ? ctx.datasets.disks : ctx.datasets.images;
      const found = space.get(orphan.name);

      return {
        kind: isDisk ? 'imp' : 'image',
        id: getChildId(orphan.name, parent),
        location: orphan.name,
        bytes: found?.used ?? 0,
        createdAt: found?.createdAt ?? null,
        snapshots: entries
          .filter((entry) => entry.type === 'snapshot' && entry.name.startsWith(`${orphan.name}@`))
          .map((snapshot) => getSnapshotId(snapshot.name)),
      };
    });

    const checkpoints = plan.orphanCheckpoints.map((snapshot): OrphanStorage => ({
      kind: 'checkpoint',
      id: getSnapshotId(snapshot.name),
      location: snapshot.name,
      bytes: space.get(snapshot.name)?.used ?? 0,
      createdAt: space.get(snapshot.name)?.createdAt ?? null,
      snapshots: [],
    }));

    return [...datasetOrphans, ...checkpoints, ...dirs];
  };

  // Drops what the database no longer names and a crash explains, and the
  // orphans with `isOrphans`. Snapshots go first: a retire renames the
  // dataset they are on. The caller runs it serially.
  const removeLeftovers = async (
    live: LiveStorage,
    options: Readonly<{ isDryRun: boolean; isOrphans: boolean }>,
  ): Promise<SweepResult> => {
    const entries = await ctx.listAll();

    const names = new Set(entries.map((entry) => entry.name));

    const plan = planLeftovers(entries, live, options.isOrphans);

    const kept = await readOrphans(entries, plan);

    if (options.isDryRun) {
      return { dropped: toDropped(plan), kept };
    }

    for (const snapshot of plan.snapshots) {
      await ctx.zfs.destroyDeferred(snapshot.name);
    }

    for (const disk of plan.disks) {
      await ctx.removeMount(ctx.buildDiskDir(getChildId(disk.name, ctx.datasets.disks)));
      await ctx.removeDataset(disk.name);
    }

    for (const image of plan.images) {
      await ctx.removeMount(ctx.buildImageDir(getChildId(image.name, ctx.datasets.images)));

      // a crash between the rename and the snapshot leaves an image without one
      if (names.has(`${image.name}@base`)) {
        await ctx.zfs.destroyDeferred(`${image.name}@base`);
      }

      await ctx.removeDataset(image.name);
    }

    // an imp's directory holds its disk's mount point: never one in use
    const mounted = [...parseZfsMounts(ctx.readMounts()).keys()];

    for (const impId of plan.impDirs) {
      const directory = buildImpPaths(ctx.dataDir, impId).directory;

      if (!mounted.some((mount) => mount.startsWith(`${directory}/`))) {
        rmSync(directory, { recursive: true, force: true });
      }
    }

    for (const impId of plan.memDirs) {
      rmSync(join(ctx.dataDir, 'mem', impId), { recursive: true, force: true });
    }

    return { dropped: toDropped(plan), kept };
  };

  return { removeLeftovers };
}

function getSnapshotDataset(name: string): string {
  return name.slice(0, name.indexOf('@'));
}
