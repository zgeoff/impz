import { BUILDER_IMAGE } from '../../imps/images/builders/builder-imps';
import { createImage } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';
import { buildImagePaths } from '../../vm/storage/data-layout';

interface BuilderImageOptions {
  readonly db: ImpDatabase;
  readonly dataDir: string;
  readonly ref: string;
}

export async function createBuilderImage(options: BuilderImageOptions): Promise<ImageRecord> {
  const rootfs = 'rootfs';
  const digest = `sha256:${new Bun.CryptoHasher('sha256').update(rootfs).digest('hex')}`;

  await Bun.write(buildImagePaths(options.dataDir, digest).rootfs, rootfs);

  return createImage(options.db, {
    name: BUILDER_IMAGE,
    ref: options.ref,
    digest,
    sizeBytes: 6,
  });
}
