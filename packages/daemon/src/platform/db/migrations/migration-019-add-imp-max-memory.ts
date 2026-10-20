import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// elastic memory (#35): the most an imp's guest may grow to; null is no
// growth, the guest stays at memory_mib
export const MIGRATION_019_ADD_IMP_MAX_MEMORY: Migration = {
  async up(db: Kysely<NoTables>) {
    // the most the guest may grow to with hot-plugged memory; null when it
    // stays at memory_mib (docs/architecture/lifecycle/elastic-memory.md)
    await db.schema.alterTable('imps').addColumn('max_memory_mib', 'integer').execute();
  },
};
