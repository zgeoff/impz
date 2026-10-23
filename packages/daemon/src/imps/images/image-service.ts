import {
  listImages,
  readImageByName,
  removeImage,
  removeImageRemoval,
  updateImagePin,
  updateImageUse,
} from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import { countImpsUsingImage } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import { buildConflictError, buildNotFoundError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { ImpsConfig } from '../imps-config';
import { createImageBuilds } from './build/create-image-builds';
import type { ImageBuilds } from './build/create-image-builds';
import type { Builders } from './builders/builder-imps';
import { FALLBACK_DEFAULT_IMAGE, createImageAdds } from './create-image-adds';
import type { ImageAdds } from './create-image-adds';
import { createImageEviction } from './eviction/create-image-eviction';
import { createImageWriter } from './rootfs/create-image-writer';
import type { ImageWriter } from './rootfs/create-image-writer';

export type ImageService = ImageAdds &
  ImageBuilds & {
    readonly listImages: () => Promise<ImageRecord[]>;
    readonly removeImage: (name: string) => Promise<void>;

    readonly resolveImage: (name?: string) => Promise<ImageRecord>;

    readonly findDefaultImage: () => Promise<ImageRecord | undefined>;

    readonly updateImagePin: (name: string, isPinned: boolean) => Promise<ImageRecord>;

    readonly runImageEviction: () => Promise<void>;

    readonly withImagePublisher: ImageWriter['withPublisher'];
  };

export interface ImageServiceDeps {
  readonly config: ImpsConfig;
  readonly db: ImpDatabase;
  readonly storage: StorageBackend;

  readonly storageGate: StorageGate;

  readonly diskBudget: Pick<DiskBudget, 'withRoom' | 'withGrowingRoom'>;

  readonly readBuilders: () => Builders | null;
  readonly log: (message: string) => void;

  readonly builderImagePullMs?: number | undefined;

  readonly startPullLimit?: (pullMs: number) => AbortSignal;

  readonly dockerEnv?: Readonly<Record<string, string>>;

  readonly seedRef?: string | null;

  readonly now?: () => number;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const writer = createImageWriter(deps);
  const now = deps.now ?? Date.now;
  const builds = createImageBuilds(deps, writer);
  const adds = createImageAdds(deps, writer);

  const eviction = createImageEviction({
    config: deps.config,
    db: deps.db,
    storage: deps.storage,
    storageGate: deps.storageGate,
    removeIdleImage: writer.removeIdleImage,
    removeIdleRootfs: writer.removeIdleRootfs,
    log: deps.log,
    now,
  });

  const runEviction = async (): Promise<void> => {
    try {
      await eviction.runEviction();
    } catch (error) {
      deps.log(`impd: image eviction: ${getErrorMessage(error)}`);
    }
  };

  const withEviction = async (write: () => Promise<ImageRecord>): Promise<ImageRecord> => {
    try {
      return await write();
    } finally {
      await runEviction();
    }
  };

  const readDefaultImage = async (): Promise<ImageRecord | undefined> => {
    for (const name of [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE]) {
      const image = await readImageByName(deps.db, name);

      if (image !== undefined) {
        return image;
      }
    }

    return undefined;
  };

  const resolveImage = async (name?: string): Promise<ImageRecord> => {
    const names = name === undefined ? [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE] : [name];

    // The use goes in before the read, so an eviction either sees it and keeps the image, or
    // removed the image first and the read finds nothing.
    await updateImageUse(deps.db, 'name', names, now());

    const image =
      name === undefined ? await readDefaultImage() : await readImageByName(deps.db, name);

    if (image === undefined) {
      throw buildNotFoundError('image', name ?? deps.config.defaultImage);
    }

    return image;
  };

  return {
    ...adds,
    ...builds,
    addImage: (...args) => withEviction(() => adds.addImage(...args)),
    runImageBuild: (...args) => withEviction(() => builds.runImageBuild(...args)),
    buildImageFromContext: (...args) => withEviction(() => builds.buildImageFromContext(...args)),
    listImages: () => listImages(deps.db),
    removeImage: async (name) => {
      const image = await readImageByName(deps.db, name);

      if (image === undefined) {
        throw buildNotFoundError('image', name);
      }

      const users = await countImpsUsingImage(deps.db, image.id);

      if (users > 0) {
        throw buildConflictError('image', name, `image ${name} is used by ${String(users)} imp(s)`);
      }

      await deps.storageGate.join(async () => {
        await removeImage(deps.db, image.id);

        const isRemoved = await writer.removeIdleRootfs(image.digest);

        if (isRemoved) {
          await removeImageRemoval(deps.db, image.digest);
        }
      });
    },
    updateImagePin: async (name, isPinned) => {
      const image = await updateImagePin(deps.db, name, isPinned);

      if (image === undefined) {
        throw buildNotFoundError('image', name);
      }

      return image;
    },
    resolveImage,
    findDefaultImage: readDefaultImage,
    runImageEviction: runEviction,
    withImagePublisher: writer.withPublisher,
  };
}
