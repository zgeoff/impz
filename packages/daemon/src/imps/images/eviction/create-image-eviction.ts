import { formatBytes } from '@impz/shared';
import {
  listImageRemovals,
  listImageUses,
  removeImageRemoval,
  removeUnusedImage,
  updateImageUse,
} from '../../../platform/db/images';
import type { ImageUse } from '../../../platform/db/images';
import type { ImpDatabase } from '../../../platform/db/open-database';
import type { Clock } from '../../../platform/process/clock';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import type { StorageBackend } from '../../../vm/storage/storage-backend';
import type { StorageGate } from '../../../vm/storage/storage-gate';
import type { ImpsConfig } from '../../imps-config';
import { FALLBACK_DEFAULT_IMAGE } from '../create-image-adds';
import type { ImageWriter } from '../rootfs/create-image-writer';
import { isOverHighMark } from './is-over-high-mark';
import { pickEvictedImages } from './pick-evicted-images';

export interface ImageEviction {
  readonly runEviction: () => Promise<void>;
}

export interface ImageEvictionDeps {
  readonly config: Pick<ImpsConfig, 'imageEviction' | 'defaultImage'>;
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'readUsage' | 'measureImages'>;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly removeIdleImage: ImageWriter['removeIdleImage'];
  readonly removeIdleRootfs: ImageWriter['removeIdleRootfs'];
  readonly clock: Pick<Clock, 'now'>;
}

export function createImageEviction(deps: ImageEvictionDeps): ImageEviction {
  const logger = getImpdLogger('image');

  const removeImage = async (use: Readonly<ImageUse>): Promise<void> => {
    try {
      const isRemoved = await deps.storageGate.join(() =>
        deps.removeIdleImage(use.digest, () => removeUnusedImage(deps.db, use.id, use.lastUsedAt)),
      );

      if (isRemoved) {
        await removeImageRemoval(deps.db, use.digest);

        logger.info('image eviction: removed {name} ({size}, last used {lastUsedAt})', {
          name: use.name,
          size: formatBytes(use.sizeBytes),
          lastUsedAt: new Date(use.lastUsedAt).toISOString(),
        });
      }
    } catch (error) {
      logger.warning('image eviction: could not remove {name}: {error}', {
        name: use.name,
        error: getErrorMessage(error),
      });
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
        logger.warning(
          'image eviction: could not remove the rootfs of {digest}, and tries again at the next image write: {error}',
          { digest, error: getErrorMessage(error) },
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

    const at = deps.clock.now();

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

  const passes: { running: Promise<void> | undefined; isQueued: boolean } = {
    running: undefined,
    isQueued: false,
  };

  const runPasses = async (): Promise<void> => {
    try {
      do {
        passes.isQueued = false;

        await runOnce();
      } while (passes.isQueued);
    } finally {
      passes.running = undefined;
    }
  };

  return {
    runEviction: () => {
      if (passes.running !== undefined) {
        passes.isQueued = true;

        return passes.running;
      }

      passes.running = runPasses();

      return passes.running;
    },
  };
}
