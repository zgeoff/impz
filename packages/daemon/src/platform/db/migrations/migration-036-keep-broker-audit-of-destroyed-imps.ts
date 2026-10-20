import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// A destroyed imp's broker audit rows stay under its name, as its API audit
// rows do, and a request that ends after the imp still gets its row. SQLite
// cannot drop a foreign key in place, so a table copy replaces it, as in 030.
export const MIGRATION_036_KEEP_BROKER_AUDIT_OF_DESTROYED_IMPS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .createTable('broker_audit_kept')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('imp_id', 'text', (column) => column.notNull())
        .addColumn('imp_name', 'text', (column) => column.notNull())
        .addColumn('secret_name', 'text')
        .addColumn('at', 'integer', (column) => column.notNull())
        .addColumn('method', 'text')
        .addColumn('host', 'text')
        .addColumn('path', 'text')
        .addColumn('status', 'integer', (column) => column.notNull())
        .addColumn('request_bytes', 'integer', (column) => column.notNull())
        .addColumn('response_bytes', 'integer', (column) => column.notNull())
        .addColumn('duration_ms', 'integer', (column) => column.notNull())
        .addColumn('reason', 'text')
        .execute();

      // the foreign key kept every row's imp, so each finds its name; a row
      // that outlived its imp with the keys off takes its imp id as its name
      await sql`
        INSERT INTO broker_audit_kept
          (id, imp_id, imp_name, secret_name, at, method, host, path, status, request_bytes,
           response_bytes, duration_ms, reason)
        SELECT broker_audit.id, broker_audit.imp_id, COALESCE(imps.name, broker_audit.imp_id),
          secret_name, at, method, host, path, status, request_bytes, response_bytes,
          duration_ms, reason
        FROM broker_audit
        LEFT JOIN imps ON imps.id = broker_audit.imp_id
      `.execute(trx);

      await trx.schema.dropTable('broker_audit').execute();
      await trx.schema.alterTable('broker_audit_kept').renameTo('broker_audit').execute();

      await trx.schema
        .createIndex('broker_audit_imp_id')
        .on('broker_audit')
        .columns(['imp_id', 'id'])
        .execute();
    });
  },
};
