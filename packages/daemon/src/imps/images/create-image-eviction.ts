import { formatBytes } from '@impz/shared';
import type { Config } from '../../config';
import {
  listImageRemovals,
  listImageUses,
  removeImageRemoval,
  removeUnusedImage,
  updateImageUse,
} from '../../platform/db/images';
import type { ImageUse } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSingleFlight } from '../../platform/process/single-flight';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { FALLBACK_DEFAULT_IMAGE } from './create-image-adds';
import type { ImageWriter } from './create-image-writer';
import { isOverHighMark } from './is-over-high-mark';
import { pickEvictedImages } from './pick-evicted-images';

export interface ImageEviction {
  readonly runEviction: () => Promise<void>;
}

export interface ImageEvictionDeps {
  readonly config: Pick<Config, 'imageEviction' | 'defaultImage'>;
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'readUsage' | 'measureImages'>;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly removeIdleImage: ImageWriter['removeIdleImage'];
  readonly removeIdleRootfs: ImageWriter['removeIdleRootfs'];
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

export function createImageEviction(deps: ImageEvictionDeps): ImageEviction {
  const now = deps.now ?? Date.now;
  const flight = createSingleFlight<void>();

  const removeImage = async (use: Readonly<ImageUse>): Promise<void> => {
    try {
      const isRemoved = await deps.storageGate.join(() =>
        deps.removeIdleImage(use.digest, () => removeUnusedImage(deps.db, use.id, use.lastUsedAt)),
      );

      if (isRemoved) {
        await removeImageRemoval(deps.db, use.digest);

        deps.log(
          `impd: image eviction: removed ${use.name} (${formatBytes(use.sizeBytes)}, last used ${new Date(use.lastUsedAt).toISOString()})`,
        );
      }
    } catch (error) {
      deps.log(`impd: image eviction: could not remove ${use.name}: ${getErrorMessage(error)}`);
    }
  };

  const removeLeftoverRootfs = async (): Promise<void> => {
    const digests = await listImageRemovals(deps.db);

    for (const digest of digests) {
      try {
        const isRemoved = await deps.storageGate.join(() => deps.removeIdleRootfs(digest));

        if (isRemoved) {
          await removeImageRemoval(deps.db, digest);
        }
      } catch (error) {
        deps.log(
          `impd: image eviction: could not remove the rootfs of ${digest}, and tries again at the next image write: ${getErrorMessage(error)}`,
        );
      }
    }
  };

  const runOnce = async (): Promise<void> => {
    await removeLeftoverRootfs();

    const marks = deps.config.imageEviction;

    if (marks === null) {
      return;
    }

    const at = now();

    const uses = await listImageUses(deps.db);

    await updateImageUse(
      deps.db,
      'id',
      uses.filter((use) => use.impCount > 0).map((use) => use.id),
      at,
    );

    const usage = await deps.storage.readUsage();

    if (!isOverHighMark(usage, marks)) {
      return;
    }

    const report = await deps.storage.measureImages([...new Set(uses.map((use) => use.digest))]);

    // The measure lets the storage settle the frees of earlier removals first.
    const settled = await deps.storage.readUsage();

    const evicted = pickEvictedImages(
      {
        uses,
        keptNames: new Set([deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE]),
        spaces: report.images,
        usedBytes: settled.usedBytes,
        availableBytes: settled.availableBytes + report.freeingBytes,
        now: at,
      },
      marks,
    );

    for (const use of evicted) {
      await removeImage(use);
    }
  };

  return {
    runEviction: () => flight.run('eviction', runOnce),
  };
}
