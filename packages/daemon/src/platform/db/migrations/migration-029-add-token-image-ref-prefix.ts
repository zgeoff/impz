import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_029_ADD_TOKEN_IMAGE_REF_PREFIX: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('tokens')

      .addColumn('image_ref_prefix', 'text')
      .execute();
  },
};
