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
import {
  buildConflictError,
  buildForbiddenError,
  buildNotFoundError,
} from '../../platform/errors/impd-errors';
import type { Clock } from '../../platform/process/clock';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { REAL_CLOCK } from '../../platform/process/real-clock';
import { runStreamed } from '../../platform/process/run-streamed';
import type { StreamedRunner } from '../../platform/process/run-streamed';
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
    readonly readImage: (name: string) => Promise<ImageRecord | undefined>;
    readonly removeImage: (name: string) => Promise<void>;

    readonly resolveImage: (name?: string) => Promise<ImageRecord>;

    readonly findDefaultImage: () => Promise<ImageRecord | undefined>;

    readonly updateImagePin: (
      name: string,
      isPinned: boolean,
      refPrefix: string | null,
    ) => Promise<ImageRecord>;

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

  readonly builderImagePullMs?: number | undefined;

  readonly startPullLimit?: (pullMs: number) => AbortSignal;

  readonly seedRef?: string | null;

  readonly clock?: Pick<Clock, 'now'>;

  readonly runStreamed?: StreamedRunner;
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const clock = deps.clock ?? REAL_CLOCK;

  const writer = createImageWriter({
    ...deps,
    clock,
    runStreamed: deps.runStreamed ?? runStreamed,
  });

  const builds = createImageBuilds({ ...deps, clock }, writer);
  const adds = createImageAdds({ ...deps, clock }, writer);

  const eviction = createImageEviction({
    config: deps.config,
    db: deps.db,
    storage: deps.storage,
    storageGate: deps.storageGate,
    removeIdleImage: writer.removeIdleImage,
    removeIdleRootfs: writer.removeIdleRootfs,
    clock,
  });

  const runEviction = async (): Promise<void> => {
    try {
      await eviction.runEviction();
    } catch (error) {
      getImpdLogger('image').error('image eviction: {error}', { error: getErrorMessage(error) });
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
    await updateImageUse(deps.db, 'name', names, clock.now());

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
    readImage: (name) => readImageByName(deps.db, name),
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
    updateImagePin: async (name, isPinned, refPrefix) => {
      const image = await updateImagePin(deps.db, name, isPinned, refPrefix);

      if (image !== undefined) {
        return image;
      }

      const held = refPrefix === null ? undefined : await readImageByName(deps.db, name);

      if (refPrefix !== null && held !== undefined) {
        throw buildForbiddenError(`image ${name} has a ref that does not start with ${refPrefix}`);
      }

      throw buildNotFoundError('image', name);
    },
    resolveImage,
    findDefaultImage: readDefaultImage,
    runImageEviction: runEviction,
    withImagePublisher: writer.withPublisher,
  };
}
