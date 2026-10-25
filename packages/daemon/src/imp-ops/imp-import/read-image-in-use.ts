import { readImageByDigest, updateImageUse } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';

// The use goes in before the read, so an image eviction keeps the image the import picks.
export async function readImageInUse(
  db: ImpDatabase,
  digests: readonly string[],
  now: number,
): Promise<ImageRecord | undefined> {
  await updateImageUse(db, 'digest', digests, now);

  return readImageByDigest(db, digests);
}
