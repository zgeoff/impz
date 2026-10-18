import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

export const MIGRATION_001_CREATE_INITIAL_SCHEMA: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .createTable('images')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull().unique())
      .addColumn('ref', 'text', (c) => c.notNull())
      .addColumn('digest', 'text', (c) => c.notNull())
      .addColumn('size_bytes', 'integer', (c) => c.notNull())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('imps')
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('name', 'text', (c) => c.notNull().unique())
      .addColumn('image_id', 'text', (c) => c.notNull().references('images.id'))
      .addColumn('state', 'text', (c) => c.notNull())
      .addColumn('vcpus', 'integer', (c) => c.notNull())
      .addColumn('memory_mib', 'integer', (c) => c.notNull())
      .addColumn('slot', 'integer', (c) => c.notNull().unique())
      .addColumn('ip', 'text', (c) => c.notNull().unique())
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('last_active_at', 'integer', (c) => c.notNull())
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
      .addColumn('id', 'text', (c) => c.primaryKey())
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addColumn('label', 'text')
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addColumn('size_bytes', 'integer')
      .addUniqueConstraint('checkpoints_imp_id_label_unique', ['imp_id', 'label'])
      .execute();
  },
};
