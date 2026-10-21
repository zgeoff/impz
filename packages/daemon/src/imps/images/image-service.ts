import type { Config } from '../../config';
import { listImages, readImageByName, removeImage } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import { countImpsUsingImage } from '../../platform/db/imps';
import type { ImpDatabase } from '../../platform/db/open-database';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildConflictError, buildNotFoundError } from '../../surface/api-errors';
import type { DiskBudget } from '../../vm/storage/disk-budget';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { StorageGate } from '../../vm/storage/storage-gate';
import type { Builders } from './builder-imps';
import { FALLBACK_DEFAULT_IMAGE, createImageAdds } from './create-image-adds';
import type { ImageAdds } from './create-image-adds';
import { createImageBuilds } from './create-image-builds';
import type { ImageBuilds } from './create-image-builds';
import { createImageWriter } from './create-image-writer';

export type ImageService = ImageAdds &
  ImageBuilds & {
    readonly listImages: () => Promise<ImageRecord[]>;
    readonly removeImage: (name: string) => Promise<void>;

    readonly resolveImage: (name?: string) => Promise<ImageRecord>;

    readonly findDefaultImage: () => Promise<ImageRecord | undefined>;
  };

export interface ImageServiceDeps {
  readonly config: Config;
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
    const image =
      name === undefined ? await readDefaultImage() : await readImageByName(deps.db, name);

    if (image === undefined) {
      throw buildNotFoundError('image', name ?? deps.config.defaultImage);
    }

    return image;
  };

  return {
    ...createImageAdds(deps, writer),
    ...createImageBuilds(deps, writer),
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

        await writer.removeIdleRootfs(image.digest);
      });
    },
    resolveImage,
    findDefaultImage: readDefaultImage,
  };
}
