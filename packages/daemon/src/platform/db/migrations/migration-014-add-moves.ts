import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_014_ADD_MOVES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema.alterTable('imps').addColumn('move_state', 'text').execute();

    await db.schema
      .createTable('move_tickets')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('secret_sha256', 'text', (column) => column.notNull().unique())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('bytes', 'integer', (column) => column.notNull())

      .addColumn('imp_id', 'text')
      .addColumn('issued_at', 'integer', (column) => column.notNull())
      .addColumn('stream_by', 'integer', (column) => column.notNull())
      .addColumn('stream_used_at', 'integer')

      .addColumn('receipt', 'text')
      .addColumn('commit_until', 'integer')
      .addColumn('committed_at', 'integer')
      .execute();

    await db.schema
      .createTable('move_sends')
      .addColumn('imp_id', 'text', (column) => column.primaryKey())
      .addColumn('peer_url', 'text')
      .addColumn('ticket', 'text')
      .addColumn('total_bytes', 'integer', (column) => column.notNull())

      .addColumn('mode', 'text', (column) => column.notNull().defaultTo('files'))
      .addColumn('receipt', 'text')
      .addColumn('error', 'text')
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();
  },
};
