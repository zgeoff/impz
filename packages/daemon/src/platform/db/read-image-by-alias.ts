import { toImageRecord } from './create-image';
import type { ImageRecord } from './create-image';
import type { ImpDatabase } from './open-database';

export async function readImageByAlias(
  db: ImpDatabase,
  alias: string,
): Promise<ImageRecord | undefined> {
  const row = await db
    .selectFrom('images')
    .selectAll('images')
    .innerJoin('image_aliases', 'image_aliases.image_id', 'images.id')
    .where('image_aliases.name', '=', alias)
    .executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}
