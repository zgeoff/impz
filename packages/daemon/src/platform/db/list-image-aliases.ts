import type { ImpDatabase } from './open-database';

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
