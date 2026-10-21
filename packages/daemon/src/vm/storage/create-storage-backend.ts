import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../../config';
import { buildImpsDir } from './data-layout';
import type { StorageBackend, StorageBackendKind } from './storage-backend';
import { createXfsBackend } from './xfs-backend';
import { createZfsBackend } from './zfs/zfs-backend';
import type { ZfsBackendDeps } from './zfs/zfs-backend';

const MARKER_FILE = 'storage-backend';

interface StorageBoundaries {
  readonly xfsReserveFileBytes?: number;
  readonly zfs?: Omit<ZfsBackendDeps, 'dataDir' | 'root' | 'isUiomoveBugAllowed'>;
}

export function createStorageBackend(
  config: Config,
  boundaries: Readonly<StorageBoundaries> = {},
): StorageBackend {
  checkStorageMarker(config.dataDir, config.storageBackend);

  const backend = createBackend(config, boundaries);

  return {
    ...backend,
    start: async (live) => {
      await backend.start(live);

      // a marker written before ZFS mounts its dataset on the data dir would sit hidden under it
      writeStorageMarker(config.dataDir, config.storageBackend);
    },
  };
}

// removing the reserve frees room for a destroy to run on a full filesystem
const XFS_RESERVE_FILE_BYTES = 1024 ** 3;

function createBackend(config: Config, boundaries: Readonly<StorageBoundaries>): StorageBackend {
  if (config.storageBackend === 'xfs') {
    return createXfsBackend({
      dataDir: config.dataDir,
      reserveFileBytes: boundaries.xfsReserveFileBytes ?? XFS_RESERVE_FILE_BYTES,
    });
  }

  if (config.zfsRoot === null) {
    throw new Error('IMP_STORAGE_BACKEND=zfs needs IMP_ZFS_ROOT');
  }

  return createZfsBackend({
    ...boundaries.zfs,
    dataDir: config.dataDir,
    root: config.zfsRoot,
    isUiomoveBugAllowed: config.isUiomoveBugAllowed,
  });
}

export function checkStorageMarker(dataDir: string, kind: StorageBackendKind): void {
  const marker = join(dataDir, MARKER_FILE);
  const recorded = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : readUnmarked(dataDir);

  if (recorded !== null && recorded !== kind) {
    throw new Error(
      `${dataDir} holds ${recorded} storage, but IMP_STORAGE_BACKEND is ${kind}; moving imps between backends is not supported`,
    );
  }
}

export function writeStorageMarker(dataDir: string, kind: StorageBackendKind): void {
  const marker = join(dataDir, MARKER_FILE);

  if (!existsSync(marker)) {
    writeFileSync(marker, `${kind}\n`);
  }
}

function readUnmarked(dataDir: string): StorageBackendKind | null {
  const imps = buildImpsDir(dataDir);
  const hasImps = existsSync(imps) && readdirSync(imps).length > 0;

  return hasImps ? 'xfs' : null;
}
