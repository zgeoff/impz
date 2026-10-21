import type { Config } from './config';
import type { ImpdDeps } from './impd-deps';
import type { Builders } from './imps/images/builder-imps';
import { createImageService } from './imps/images/image-service';
import type { ImageService } from './imps/images/image-service';
import { printLog } from './platform/process/print-log';
import { createDiskBudget } from './vm/storage/disk-budget';
import type { DiskBudget } from './vm/storage/disk-budget';
import { createDiskUsageCache } from './vm/storage/disk-usage-cache';
import type { DiskUsageCache } from './vm/storage/disk-usage-cache';
import { createStorageGate } from './vm/storage/storage-gate';
import type { StorageGate } from './vm/storage/storage-gate';

export interface ImpdStorage {
  readonly storageGate: StorageGate;
  readonly diskBudget: DiskBudget;
  readonly setBuilders: (builders: Builders) => void;
  readonly images: ImageService;
  readonly diskUsage: DiskUsageCache;
}

export function createImpdStorage(config: Config, deps: Readonly<ImpdDeps>): ImpdStorage {
  const log = deps.log ?? printLog;
  const storage = deps.storage;
  const storageGate = createStorageGate();
  const zfsCommitDelayMs = config.storageBackend === 'zfs' ? 20_000 : 0;

  const diskBudget = createDiskBudget({
    storage: deps.readDiskSpace === undefined ? storage : { readUsage: deps.readDiskSpace },
    reserveBytes: config.diskReserveBytes,
    releaseDelayMs: zfsCommitDelayMs,
    log,
  });

  const buildersHolder: { builders: Builders | null } = { builders: null };

  const images = createImageService({
    config,
    db: deps.db,
    storage,
    storageGate,
    diskBudget,
    readBuilders: () => buildersHolder.builders,
    log,
    ...(deps.now !== undefined && { now: deps.now }),
    ...deps.images,
  });

  const diskUsage = createDiskUsageCache({ db: deps.db, storage, log });

  return {
    storageGate,
    diskBudget,
    setBuilders: (builders) => {
      buildersHolder.builders = builders;
    },
    images,
    diskUsage,
  };
}
