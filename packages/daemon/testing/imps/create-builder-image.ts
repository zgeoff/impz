import { BUILDER_IMAGE } from '../../src/imps/images/builder-imps';
import { createImage } from '../../src/platform/db/images';
import type { ImageRecord } from '../../src/platform/db/images';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import { buildImagePaths } from '../../src/vm/storage/data-layout';

interface BuilderImageOptions {
  readonly db: ImpDatabase;
  readonly dataDir: string;

  // the IMP_BUILD_IMAGE reference the row records
  readonly ref: string;
}

// The builders' image as if impd had added it already, with a rootfs the
// builder imps boot from: a state the service reaches only through the host
// engine's pull, create and export of IMP_BUILD_IMAGE.
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
