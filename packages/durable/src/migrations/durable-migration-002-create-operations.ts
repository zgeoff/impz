import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

type NoTables = Record<string, never>;

export const DURABLE_MIGRATION_002_CREATE_OPERATIONS: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('operations')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('kind', 'text', (column) => column.notNull())
      .addColumn('target_id', 'text')
      .addColumn('parent_id', 'text')
      .addColumn('principal', 'text', (column) => column.notNull())
      .addColumn('retry_key', 'text', (column) => column.unique())
      .addColumn('params', 'text', (column) => column.notNull())
      .addColumn('state', 'text', (column) => column.notNull())
      .addColumn('current_step', 'text')
      .addColumn('result', 'text')
      .addColumn('error_code', 'text')
      .addColumn('error_message', 'text')
      .addColumn('ending', 'text')
      .addColumn('cancel_requested', 'integer', (column) => column.notNull())
      .addColumn('revision', 'integer', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('started_at', 'integer')
      .addColumn('ended_at', 'integer')
      .execute();

    await db.schema.createIndex('operations_state').on('operations').column('state').execute();

    await db.schema
      .createIndex('operations_ended_at')
      .on('operations')
      .column('ended_at')
      .execute();

    await db.schema
      .createTable('operation_steps')
      .addColumn('operation_id', 'text', (column) =>
        column.notNull().references('operations.id').onDelete('cascade'),
      )
      .addColumn('position', 'integer', (column) => column.notNull())
      .addColumn('name', 'text', (column) => column.notNull())
      .addColumn('state', 'text', (column) => column.notNull())
      .addColumn('started_at', 'integer')
      .addColumn('ended_at', 'integer')
      .addColumn('error_code', 'text')
      .addColumn('error_message', 'text')
      .addColumn('undo_record', 'text')
      .addColumn('undone_at', 'integer')
      .addPrimaryKeyConstraint('operation_steps_pk', ['operation_id', 'position'])
      .execute();
  },
};
