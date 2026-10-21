import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_019_ADD_IMP_MAX_MEMORY: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('imps').addColumn('max_memory_mib', 'integer').execute();
  },
};
