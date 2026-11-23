import type { ImpDatabase } from './open-database';

export async function removeImageAlias(db: ImpDatabase, alias: string): Promise<boolean> {
  const row = await db
    .deleteFrom('image_aliases')
    .where('name', '=', alias)
    .returning('name')
    .executeTakeFirst();

  return row !== undefined;
}
