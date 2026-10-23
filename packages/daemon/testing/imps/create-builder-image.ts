import { BUILDER_IMAGE } from '../../src/imps/images/builders/builder-imps';
import { createImage } from '../../src/platform/db/images';
import type { ImageRecord } from '../../src/platform/db/images';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import { buildImagePaths } from '../../src/vm/storage/data-layout';

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
