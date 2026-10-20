import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import { LEGACY_DISK_BYTES } from '../../process/legacy-disk-bytes';
import type { NoTables } from './no-tables';

// a disk size per imp and per checkpoint (docs/architecture/storage/storage.md)
export const MIGRATION_005_ADD_DISK_SIZES: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      // the disk file's size; 32 GiB for an imp from before sizes
      .addColumn('disk_bytes', 'integer', (column) => column.notNull().defaultTo(LEGACY_DISK_BYTES))
      .execute();

    await db.schema
      .alterTable('imps')

      // 1 while a sleeping imp's guest has not grown into a resize yet: its
      // next wake grows it, a cold boot grows it anyway
      .addColumn('disk_grow_pending', 'integer', (column) => column.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('checkpoints')

      // the imp's disk size when the checkpoint was taken
      .addColumn('disk_bytes', 'integer', (column) => column.notNull().defaultTo(LEGACY_DISK_BYTES))
      .execute();
  },
};
