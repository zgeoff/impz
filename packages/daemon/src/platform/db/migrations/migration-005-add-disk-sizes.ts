import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { LEGACY_DISK_BYTES } from '../../process/legacy-disk-bytes';
import type { NoTables } from './no-tables';

export const MIGRATION_005_ADD_DISK_SIZES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      .addColumn('disk_bytes', 'integer', (column) => column.notNull().defaultTo(LEGACY_DISK_BYTES))
      .execute();

    await db.schema
      .alterTable('imps')

      .addColumn('disk_grow_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('checkpoints')

      .addColumn('disk_bytes', 'integer', (column) => column.notNull().defaultTo(LEGACY_DISK_BYTES))
      .execute();
  },
};
