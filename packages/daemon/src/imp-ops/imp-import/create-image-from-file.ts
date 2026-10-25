import type { ImageSource } from '@impz/api';
import type { ImageService } from '../../imps/images/image-service';
import { createImage } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { ImageFiles } from '../../vm/storage/write-image-files';
import { resolveImportedImageName } from './resolve-imported-image-name';

export interface ImageImportDeps {
  readonly db: ImpDatabase;
  readonly storage: Pick<StorageBackend, 'createImage'>;
  readonly images: Pick<ImageService, 'withImagePublisher'>;
  readonly now: () => number;
  readonly writeImageFiles: (files: ImageFiles, directory: string) => Promise<void>;
}

export interface ImportedImage extends ImageFiles {
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly source: ImageSource;
  readonly sourceImp: string | null;
}

export function createImageFromFile(deps: ImageImportDeps, image: ImportedImage): Promise<string> {
  return deps.images.withImagePublisher(image.digest, image.name, async () => {
    const name = await resolveImportedImageName(deps.db, image.name, image.digest);

    await deps.storage.createImage(image.digest, (directory) =>
      deps.writeImageFiles(image, directory),
    );

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
