import { toImageRecord } from './create-image';
import type { ImageRecord } from './create-image';
import type { ImpDatabase } from './open-database';

// Sets the alias, or moves it when it exists. The statement finds no row when the image is
// missing or the alias is an image's name, and leaves the target's last use alone.
export function updateImageAlias(
  db: ImpDatabase,
  alias: string,
  imageName: string,
  atMs: number,
): Promise<ImageRecord | undefined> {
  return db.transaction().execute(async (trx) => {
    const written = await trx
      .insertInto('image_aliases')
      .columns(['name', 'image_id', 'updated_at'])
      .expression((eb) =>
        eb
          .selectFrom('images')
          .select([
            eb.val(alias).as('name'),
            'images.id as image_id',
            eb.val(atMs).as('updated_at'),
          ])
          .where('images.name', '=', imageName)
          .where((inner) =>
            inner.not(
              inner.exists(
                inner
                  .selectFrom('images as taken')
                  .select('taken.id')
                  .where('taken.name', '=', alias),
              ),
            ),
          ),
      )
      .onConflict((conflict) =>
        conflict.column('name').doUpdateSet((eb) => ({
          image_id: eb.ref('excluded.image_id'),
          updated_at: eb.ref('excluded.updated_at'),
        })),
      )
      .returning('image_id')
      .executeTakeFirst();

    if (written === undefined) {
      return;
    }

    const row = await trx
      .selectFrom('images')
      .selectAll()
      .where('id', '=', written.image_id)
      .executeTakeFirst();

    return row === undefined ? undefined : toImageRecord(row);
  });
}
