import { readImageByName, updateImageUse } from '../../platform/db/images';
import type { ImageRecord } from '../../platform/db/images';
import type { ImpDatabase } from '../../platform/db/open-database';

// The use goes in before the read, so an image eviction either sees it and keeps the row, or
// removed the row first and the read finds nothing.
export async function readHeldImage(
  db: ImpDatabase,
  name: string,
  at: number,
): Promise<ImageRecord | undefined> {
  await updateImageUse(db, 'name', [name], at);

  return readImageByName(db, name);
}
