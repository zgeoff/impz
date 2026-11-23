import { getErrorMessage } from '@impz/shared';
import type { Clock } from '@zgeoff/std';
import { systemClock } from '@zgeoff/std';
import {
  listImages,
  readImageByName,
  removeImage,
  removeImageRemoval,
  updateImagePin,
  updateImageUse,
} from '../../platform/db/create-image';
import type { ImageRecord } from '../../platform/db/create-image';
import { countImpsUsingImage } from '../../platform/db/list-imps';
import type { ImpDatabase } from '../../platform/db/open-database';
import {
  isForeignKeyError,
  listImageAliases,
  readImageByAlias,
  removeImageAlias,
  updateAliasedImageUse,
  updateImageAlias,
} from '../../platform/db/update-image-alias';
import {
  buildConflictError,
  buildForbiddenError,
  buildNotFoundError,
} from '../../platform/errors/build-not-found-error';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { StreamedRunner } from '../../platform/process/run-streamed';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { ImpsConfig } from '../imps-config';
import { createImageBuilds } from './build/create-image-builds';
import type { ImageBuilds } from './build/create-image-builds';
import type { Builders } from './builders/create-builders';
import { FALLBACK_DEFAULT_IMAGE, createImageAdds } from './create-image-adds';
import type { ImageAdds } from './create-image-adds';
import { createImageEviction } from './eviction/create-image-eviction';
import { createImageWriter } from './rootfs/create-image-writer';
import type { ImageWriter, ImageWriterDeps } from './rootfs/create-image-writer';

export type ImageService = ImageAdds &
  ImageBuilds & {
    readonly listImages: () => Promise<ImageRecord[]>;
    readonly readImage: (name: string) => Promise<ImageRecord | undefined>;
    readonly removeImage: (name: string) => Promise<void>;

    readonly resolveImage: (name?: string) => Promise<ImageRecord>;

    readonly updateImageAlias: (alias: string, image: string) => Promise<ImageRecord>;
    readonly removeImageAlias: (alias: string) => Promise<void>;

    // each image id's aliases, sorted; an image with none has no entry
    readonly listImageAliases: (
      imageIds: readonly string[],
    ) => Promise<ReadonlyMap<string, readonly string[]>>;

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

  readonly runStreamed: StreamedRunner;

  readonly runCommand: ImageWriterDeps['runCommand'];

  readonly startTar: ImageWriterDeps['startTar'];

  readonly countTreeBytes: ImageWriterDeps['countTreeBytes'];

  readonly startTimer: ImageWriterDeps['startTimer'];
}

export function createImageService(deps: ImageServiceDeps): ImageService {
  const clock = deps.clock ?? systemClock;

  const writer = createImageWriter({
    ...deps,
    clock,
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

      const aliased = await readImageByAlias(deps.db, name);

      if (aliased !== undefined) {
        return aliased;
      }
    }

    return undefined;
  };

  const resolveImageName = async (name: string): Promise<ImageRecord | undefined> => {
    // The use goes in before the read, so an eviction either sees it and keeps the image, or
    // removed the image first and the read finds nothing.
    await updateImageUse(deps.db, 'name', [name], clock.now());

    const image = await readImageByName(deps.db, name);

    return image ?? updateAliasedImageUse(deps.db, name, clock.now());
  };

  const resolveImage = async (name?: string): Promise<ImageRecord> => {
    const names = name === undefined ? [deps.config.defaultImage, FALLBACK_DEFAULT_IMAGE] : [name];

    for (const candidate of names) {
      const image = await resolveImageName(candidate);

      if (image !== undefined) {
        return image;
      }
    }

    throw buildNotFoundError('image', name ?? deps.config.defaultImage);
  };

  const requireUnaliasedImage = async (image: ImageRecord): Promise<void> => {
    const found = await listImageAliases(deps.db, [image.id]);

    const aliases = found.get(image.id) ?? [];

    if (aliases.length > 0) {
      throw buildConflictError(
        'image',
        image.name,
        `image ${image.name} is pointed at by alias ${aliases.join(', ')}; remove ${aliases.length === 1 ? 'it' : 'them'} with image unalias first`,
      );
    }
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

      await requireUnaliasedImage(image);

      await deps.storageGate.join(async () => {
        // an alias set after the check above stops the delete on its foreign key
        await removeImage(deps.db, image.id).catch(async (error: unknown) => {
          if (isForeignKeyError(error)) {
            await requireUnaliasedImage(image);
          }

          throw error;
        });

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
    updateImageAlias: async (alias, imageName) => {
      const image = await updateImageAlias(deps.db, alias, imageName, clock.now());

      if (image !== undefined) {
        return image;
      }

      const target = await readImageByName(deps.db, imageName);

      if (target === undefined) {
        throw buildNotFoundError('image', imageName);
      }

      throw buildConflictError(
        'image',
        alias,
        `alias ${alias} is the name of an image; pick another alias`,
      );
    },
    removeImageAlias: async (alias) => {
      if (!(await removeImageAlias(deps.db, alias))) {
        throw buildNotFoundError('image alias', alias);
      }
    },
    listImageAliases: (imageIds) => listImageAliases(deps.db, imageIds),
    findDefaultImage: readDefaultImage,
    runImageEviction: runEviction,
    withImagePublisher: writer.withPublisher,
  };
}
