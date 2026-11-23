import type { ImpDatabase } from './open-database';

export async function probeImageAlias(db: ImpDatabase, name: string): Promise<boolean> {
  const row = await db
    .selectFrom('image_aliases')
    .select('name')
    .where('name', '=', name)
    .executeTakeFirst();

  return row !== undefined;
}
