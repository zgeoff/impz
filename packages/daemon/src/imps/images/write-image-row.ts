import { createImage, updateImage } from '../../platform/db/create-image';
import type { ImageRecord, NewImage } from '../../platform/db/create-image';
import type { ImpDatabase } from '../../platform/db/open-database';

export function writeImageRow(
  db: ImpDatabase,
  existing: ImageRecord | undefined,
  image: Readonly<NewImage>,
  at: number,
): Promise<ImageRecord> {
  if (existing === undefined) {
    return createImage(db, image, at);
  }

  return updateImage(db, existing.id, image, at);
}
