import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// an imp left out of every backup run (GEO-534): 0 keeps its disk and
// checkpoints out of the backup tree, so no restic snapshot holds them
export const MIGRATION_027_ADD_IMP_BACKUP: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')

      // 0 for an imp left out of every backup run (docs/architecture/storage/backups.md)
      .addColumn('backup', 'integer', (c) => c.notNull().defaultTo(1))
      .execute();
  },
};
