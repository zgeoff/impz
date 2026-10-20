import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// refused requests in the broker audit (GEO-286): a reason, and no secret,
// method, host or path needed. SQLite cannot drop NOT NULL in place, so a
// copy of the table replaces it in its own transaction, as in 028.
export const MIGRATION_030_ADD_BROKER_AUDIT_REFUSALS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      await trx.schema
        .createTable('broker_audit_refusals')
        .addColumn('id', 'integer', (column) => column.primaryKey().autoIncrement())
        .addColumn('imp_id', 'text', (column) =>
          column.notNull().references('imps.id').onDelete('cascade'),
        )
        .addColumn('secret_name', 'text')
        .addColumn('at', 'integer', (column) => column.notNull())
        .addColumn('method', 'text')
        .addColumn('host', 'text')
        .addColumn('path', 'text')
        .addColumn('status', 'integer', (column) => column.notNull())
        .addColumn('request_bytes', 'integer', (column) => column.notNull())
        .addColumn('response_bytes', 'integer', (column) => column.notNull())
        .addColumn('duration_ms', 'integer', (column) => column.notNull())

        // null for a request the broker sent upstream
        .addColumn('reason', 'text')
        .execute();

      await sql`
        INSERT INTO broker_audit_refusals
          (id, imp_id, secret_name, at, method, host, path, status, request_bytes,
           response_bytes, duration_ms)
        SELECT id, imp_id, secret_name, at, method, host, path, status, request_bytes,
          response_bytes, duration_ms
        FROM broker_audit
      `.execute(trx);

      await trx.schema.dropTable('broker_audit').execute();
      await trx.schema.alterTable('broker_audit_refusals').renameTo('broker_audit').execute();

      await trx.schema
        .createIndex('broker_audit_imp_id')
        .on('broker_audit')
        .columns(['imp_id', 'id'])
        .execute();
    });
  },
};
