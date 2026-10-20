import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the sessions started with `require: ['broker']`, by execution generation
// (docs/guides/connectors.md#requiring-the-broker)
export const MIGRATION_021_ADD_BROKER_SESSIONS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('broker_sessions')
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addColumn('generation', 'text', (c) => c.notNull())
      .addColumn('at', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('broker_sessions_pk', ['imp_id', 'generation'])
      .execute();
  },
};
