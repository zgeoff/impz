import { writeFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ImageSource } from '@impz/api';
import type { ImageService } from '../../imps/images/image-service';
import { createImage } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import { writeChangedBlocks } from '../../vm/storage/write-changed-blocks';
import { resolveImportedImageName } from './resolve-imported-image-name';

export interface ImageImportDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'createImage'>;
  readonly images: Pick<ImageService, 'withImagePublisher'>;
  readonly now: () => number;
}

export interface ImportedImage {
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly source: ImageSource;
  readonly sourceImp: string | null;
  readonly rootfsPath: string;
  readonly configPath: string;
}

export function createImageFromFile(deps: ImageImportDeps, image: ImportedImage): Promise<string> {
  return deps.images.withImagePublisher(image.digest, image.name, async () => {
    const name = await resolveImportedImageName(deps.db, image.name, image.digest);

    await deps.storage.createImage(image.digest, async (directory) => {
      const rootfs = join(directory, 'rootfs.ext4');

      writeFileSync(rootfs, '');

      await writeChangedBlocks(image.rootfsPath, rootfs);
      await copyFile(image.configPath, join(directory, 'config.json'));
    });

    await createImage(
      deps.db,
      {
        name,
        ref: image.ref,
        digest: image.digest,
        sizeBytes: image.sizeBytes,
        source: image.source,
        sourceImp: image.sourceImp,
      },
      deps.now(),
    );

    return name;
  });
}
