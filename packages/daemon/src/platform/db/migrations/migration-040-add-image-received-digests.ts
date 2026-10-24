import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_040_ADD_IMAGE_RECEIVED_DIGESTS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('images').addColumn('received_digest', 'text').execute();
  },
};
