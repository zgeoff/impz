import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_002_ADD_IMP_HTTP_PORT: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')
      .addColumn('http_port', 'integer', (column) => column.notNull().defaultTo(8080))
      .execute();
  },
};
