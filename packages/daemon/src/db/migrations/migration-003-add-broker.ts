import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// the credential broker: secrets, grants, the audit log, and the egress
// policy for hosts no grant covers
export const MIGRATION_003_ADD_BROKER: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      // the egress mode, `open`, `box` or `none` (docs/architecture/network/egress.md),
      // and a box's allow-list as a JSON array
      .addColumn('egress_policy', 'text', (c) => c.notNull().defaultTo('open'))
      .execute();

    // A secret's metadata. Its value is a file in <dataDir>/secrets, never a row.
    await db.schema
      .createTable('secrets')
      .addColumn('name', 'text', (c) => c.primaryKey())
      .addColumn('kind', 'text', (c) => c.notNull())

      // BrokerRule[] as JSON
      .addColumn('rules', 'text', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('grants')
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addColumn('secret_name', 'text', (c) =>
        c.notNull().references('secrets.name').onDelete('cascade'),
      )
      .addPrimaryKeyConstraint('grants_pk', ['imp_id', 'secret_name'])
      .execute();

    await db.schema
      .createTable('broker_audit')
      .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addColumn('secret_name', 'text', (c) => c.notNull())
      .addColumn('at', 'integer', (c) => c.notNull())
      .addColumn('method', 'text', (c) => c.notNull())
      .addColumn('host', 'text', (c) => c.notNull())
      .addColumn('path', 'text', (c) => c.notNull())
      .addColumn('status', 'integer', (c) => c.notNull())
      .addColumn('request_bytes', 'integer', (c) => c.notNull())
      .addColumn('response_bytes', 'integer', (c) => c.notNull())
      .addColumn('duration_ms', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createIndex('broker_audit_imp_id')
      .on('broker_audit')
      .columns(['imp_id', 'id'])
      .execute();
  },
};
