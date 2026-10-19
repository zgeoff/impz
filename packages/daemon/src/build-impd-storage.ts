import type { Config } from './config';
import type { ImpdDeps } from './create-impd';
import type { Builders } from './images/builder-imps';
import { createImageService } from './images/image-service';
import type { ImageService } from './images/image-service';
import { printLog } from './process/print-log';
import { createDiskBudget } from './storage/disk-budget';
import type { DiskBudget } from './storage/disk-budget';
import { createDiskUsageCache } from './storage/disk-usage-cache';
import type { DiskUsageCache } from './storage/disk-usage-cache';
import { createStorageGate } from './storage/storage-gate';
import type { StorageGate } from './storage/storage-gate';

// What the storage services need, and the data dir's backend
export interface ImpdStorage {
  readonly storageGate: StorageGate;
  readonly diskBudget: DiskBudget;

  // the builders, once the imps they run as exist
  readonly setBuilders: (builders: Builders) => void;
  readonly images: ImageService;
  readonly diskUsage: DiskUsageCache;
}

// The storage gate, the disk budget, the images and the usage cache
export function buildImpdStorage(config: Config, deps: Readonly<ImpdDeps>): ImpdStorage {
  const log = deps.log ?? printLog;
  const storage = deps.storage;

  // every operation that makes storage before its row joins it; the GC waits
  const storageGate = createStorageGate();
  const zfsCommitDelayMs = config.storageBackend === 'zfs' ? 20_000 : 0;

  const diskBudget = createDiskBudget({
    storage: deps.readDiskSpace === undefined ? storage : { readUsage: deps.readDiskSpace },
    reserveBytes: config.diskReserveBytes,
    releaseDelayMs: zfsCommitDelayMs,
    log,
  });

  // the image builders need the imps, which need the images
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
