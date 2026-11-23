import { toImageRecord } from './create-image';
import type { ImageRecord } from './create-image';
import type { ImpDatabase } from './open-database';

export async function probeImageAlias(db: ImpDatabase, name: string): Promise<boolean> {
  const row = await db
    .selectFrom('image_aliases')
    .select('name')
    .where('name', '=', name)
    .executeTakeFirst();

  return row !== undefined;
}

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

// reads the target and records its use in one statement, so an eviction either sees the use and
// keeps the image, or removed it first and the read finds nothing
export async function updateAliasedImageUse(
  db: ImpDatabase,
  alias: string,
  at: number,
): Promise<ImageRecord | undefined> {
  const row = await db
    .updateTable('images')
    .set((eb) => ({ last_used_at: eb.fn<number>('max', ['last_used_at', eb.val(at)]) }))
    .where('id', '=', (eb) =>
      eb.selectFrom('image_aliases').select('image_aliases.image_id').where('name', '=', alias),
    )
    .returningAll()
    .executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

// Sets the alias, or moves it when it exists. The statement finds no row when the image is
// missing or the alias is an image's name, and leaves the target's last use alone.
export function updateImageAlias(
  db: ImpDatabase,
  alias: string,
  imageName: string,
  at: number,
): Promise<ImageRecord | undefined> {
  return db.transaction().execute(async (trx) => {
    const written = await trx
      .insertInto('image_aliases')
      .columns(['name', 'image_id', 'updated_at'])
      .expression((eb) =>
        eb
          .selectFrom('images')
          .select([eb.val(alias).as('name'), 'images.id as image_id', eb.val(at).as('updated_at')])
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

export async function removeImageAlias(db: ImpDatabase, alias: string): Promise<boolean> {
  const row = await db
    .deleteFrom('image_aliases')
    .where('name', '=', alias)
    .returning('name')
    .executeTakeFirst();

  return row !== undefined;
}

export async function listImageAliases(
  db: ImpDatabase,
  imageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const aliases = new Map<string, string[]>();

  if (imageIds.length === 0) {
    return aliases;
  }

  const rows = await db
    .selectFrom('image_aliases')
    .select(['name', 'image_id'])
    .where('image_id', 'in', imageIds)
    .orderBy('name')
    .execute();

  for (const row of rows) {
    aliases.set(row.image_id, [...(aliases.get(row.image_id) ?? []), row.name]);
  }

  return aliases;
}

// a foreign key stopped a delete of an image row; the message names the table, not the cause
export function isForeignKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
  );
}
