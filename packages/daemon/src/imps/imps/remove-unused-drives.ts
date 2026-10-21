import { basename } from 'node:path';
import { listImps } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { readLoadingMeta, readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { removeUnusedSystemDrives } from '../../vm/storage/remove-unused-system-drives';

export async function removeUnusedDrives(
  db: ImpDatabase,
  dataDir: string,
  findPaths: (impId: string) => ImpPaths,
  currentDrivePath: string,
  templateDrivePaths: readonly string[] = [],
): Promise<string[]> {
  const keep = await listDrivesInUse(db, findPaths);

  keep.add(basename(currentDrivePath));

  // A boot template reopens its drive on every restore.
  for (const path of templateDrivePaths) {
    keep.add(basename(path));
  }

  return removeUnusedSystemDrives(dataDir, keep);
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
