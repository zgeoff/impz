import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_001_CREATE_INITIAL_SCHEMA: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('images')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())
      .addColumn('ref', 'text', (column) => column.notNull())
      .addColumn('digest', 'text', (column) => column.notNull())
      .addColumn('size_bytes', 'integer', (column) => column.notNull())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .execute();

    await db.schema
      .createTable('imps')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('name', 'text', (column) => column.notNull().unique())
      .addColumn('image_id', 'text', (column) => column.notNull().references('images.id'))
      .addColumn('state', 'text', (column) => column.notNull())
      .addColumn('vcpus', 'integer', (column) => column.notNull())
      .addColumn('memory_mib', 'integer', (column) => column.notNull())
      .addColumn('slot', 'integer', (column) => column.notNull().unique())
      .addColumn('ip', 'text', (column) => column.notNull().unique())
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('last_active_at', 'integer', (column) => column.notNull())
      .addColumn('slept_at', 'integer')

      // the latest end of the imp's leases, kept with each lease write
      // (db/leases.ts); null while it has none
      .addColumn('hold_until', 'integer')
      .addColumn('error', 'text')
      .addColumn('pid', 'integer')
      .addColumn('firecracker_version', 'text')
      .execute();

    await db.schema
      .createTable('checkpoints')
      .addColumn('id', 'text', (column) => column.primaryKey())
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('label', 'text')
      .addColumn('created_at', 'integer', (column) => column.notNull())
      .addColumn('size_bytes', 'integer')
      .addUniqueConstraint('checkpoints_imp_id_label_unique', ['imp_id', 'label'])
      .execute();
  },
};
