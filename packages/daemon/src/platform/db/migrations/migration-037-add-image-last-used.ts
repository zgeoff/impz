import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_037_ADD_IMAGE_LAST_USED: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .alterTable('images')
        .addColumn('last_used_at', 'integer', (column) => column.notNull().defaultTo(0))
        .execute();

      await sql`
        UPDATE images SET last_used_at = MAX(
          created_at,
          COALESCE((SELECT MAX(imps.created_at) FROM imps WHERE imps.image_id = images.id), 0)
        )
      `.execute(trx);
    });
  },
};
