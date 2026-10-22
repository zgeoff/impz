import { basename } from 'node:path';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { readLoadingMeta, readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { removeUnusedSystemDrives } from '../../vm/storage/remove-unused-system-drives';

interface RemoveUnusedDrivesOptions {
  readonly dataDir: string;
  readonly findPaths: (impId: string) => ImpPaths;
  readonly currentDrivePath: string;
  readonly templateDrivePaths?: readonly string[];
}

export async function removeUnusedDrives(
  db: ImpDatabase,
  options: RemoveUnusedDrivesOptions,
): Promise<string[]> {
  const keep = await listDrivesInUse(db, options.findPaths);

  keep.add(basename(options.currentDrivePath));

  // A boot template reopens its drive on every restore.
  for (const path of options.templateDrivePaths ?? []) {
    keep.add(basename(path));
  }

  return removeUnusedSystemDrives(options.dataDir, keep);
}

async function listDrivesInUse(
  db: ImpDatabase,
  findPaths: (impId: string) => ImpPaths,
): Promise<Set<string>> {
  const drives = new Set<string>();

  for (const imp of await listImps(db)) {
    const paths = findPaths(imp.id);
    const meta = readSnapshotMeta(paths) ?? readLoadingMeta(paths);

    if (meta?.systemDrivePath !== undefined) {
      drives.add(basename(meta.systemDrivePath));
    }

    const vm = imp.pid === null ? null : readVmIdentity(paths);

    if (vm !== null) {
      drives.add(basename(vm.systemDrivePath));
    }
  }

  return drives;
}
