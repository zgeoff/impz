import { readFile } from 'node:fs/promises';
import { formatBytes } from '@impz/shared';
import type { Config } from '../../config';
import { listImageUses, removeUnusedImage, updateImageUse } from '../../platform/db/images';
import type { ImageUse } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSingleFlight } from '../../platform/process/single-flight';
import type { StorageGate } from '../../vm/storage/storage-gate';
import { FALLBACK_DEFAULT_IMAGE } from './create-image-adds';
import { parseImageKeepFile } from './parse-image-keep-file';
import type { ImageKeepFile } from './parse-image-keep-file';
import { pickPrunedImages } from './pick-pruned-images';

export interface ImagePrune {
  readonly runPrune: () => Promise<void>;
}

export interface ImagePruneDeps {
  readonly config: Pick<Config, 'imagePrune' | 'defaultImage'>;
  readonly db: ImpDatabase;
  readonly storageGate: Pick<StorageGate, 'join'>;
  readonly removeIdleRootfs: (digest: string) => Promise<void>;
  readonly log: (message: string) => void;
  readonly now?: () => number;
}

export function createImagePrune(deps: ImagePruneDeps): ImagePrune {
  const rule = deps.config.imagePrune;
  const now = deps.now ?? Date.now;
  const flight = createSingleFlight<void>();
  const state = { lastKeptAll: null as string | null };

  const removeImage = async (use: Readonly<ImageUse>): Promise<void> => {
    try {
      const isRemoved = await deps.storageGate.join(async () => {
        if (!(await removeUnusedImage(deps.db, use.id, use.lastUsedAt))) {
          return false;
        }

        await deps.removeIdleRootfs(use.digest);

        return true;
      });

      if (isRemoved) {
        deps.log(
          `impd: image prune: removed ${use.name} (${formatBytes(use.sizeBytes)}, last used ${new Date(use.lastUsedAt).toISOString()})`,
        );
      }
    } catch (error) {
      deps.log(`impd: image prune: could not remove ${use.name}: ${getErrorMessage(error)}`);
    }
  };

  const runOnce = async (): Promise<void> => {
    const keepFile = await readImageKeepFile(rule.keepFile);

    if (!keepFile.isOk) {
      if (keepFile.reason !== state.lastKeptAll) {
        deps.log(`impd: image prune: kept every image: ${rule.keepFile}: ${keepFile.reason}`);
      }

      state.lastKeptAll = keepFile.reason;

      return;
    }

    state.lastKeptAll = null;

    const keptNames = new Set([
      ...keepFile.names,
      deps.config.defaultImage,
      FALLBACK_DEFAULT_IMAGE,
    ]);

    const at = now();

    const uses = await listImageUses(deps.db);

    const plan = pickPrunedImages(uses, keptNames, rule, at);

    await updateImageUse(deps.db, plan.usedIDs, at);

    for (const use of plan.removed) {
      await removeImage(use);
    }
  };

  return {
    runPrune: () => flight.run('prune', runOnce),
  };
}

async function readImageKeepFile(path: string): Promise<ImageKeepFile> {
  try {
    const text = await readFile(path, 'utf8');

    return parseImageKeepFile(text);
  } catch (error) {
    return {
      isOk: false,
      reason: `cannot read the names of the images that configs outside impd use: ${getErrorMessage(error)}`,
    };
  }
}
