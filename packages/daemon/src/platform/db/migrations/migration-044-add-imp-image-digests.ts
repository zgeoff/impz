import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// An existing imp takes the digest its image row holds now: the digest it cloned from is
// lost once an image re-add has written over that row.
export const MIGRATION_044_ADD_IMP_IMAGE_DIGESTS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')
      .addColumn('image_digest', 'text', (column) => column.notNull().defaultTo(''))
      .execute();

    await sql`UPDATE imps SET image_digest = (
      SELECT images.digest FROM images WHERE images.id = imps.image_id
    )`.execute(db);
  },
};
