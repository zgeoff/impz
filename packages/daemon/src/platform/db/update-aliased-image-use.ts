import { toImageRecord } from './create-image';
import type { ImageRecord } from './create-image';
import type { ImpDatabase } from './open-database';

// reads the target and records its use in one statement, so an eviction either sees the use and
// keeps the image, or removed it first and the read finds nothing
export async function updateAliasedImageUse(
  db: ImpDatabase,
  alias: string,
  atMs: number,
): Promise<ImageRecord | undefined> {
  const row = await db
    .updateTable('images')
    .set((eb) => ({ last_used_at: eb.fn<number>('max', ['last_used_at', eb.val(atMs)]) }))
    .where('id', '=', (eb) =>
      eb.selectFrom('image_aliases').select('image_aliases.image_id').where('name', '=', alias),
    )
    .returningAll()
    .executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}
