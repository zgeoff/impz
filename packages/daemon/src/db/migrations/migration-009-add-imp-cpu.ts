import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// CPU limits, and how often and how long each imp was awake
export const MIGRATION_009_ADD_IMP_CPU: Migration = {
  async up(db: Kysely<NoTables>) {
    // cores the VM may use, null for no limit; its share under contention
    await db.schema.alterTable('imps').addColumn('cpu_limit', 'real').execute();

    await db.schema
      .alterTable('imps')
      .addColumn('cpu_weight', 'integer', (c) => c.notNull().defaultTo(100))
      .execute();

    await db.schema
      .alterTable('imps')
      .addColumn('wake_count', 'integer', (c) => c.notNull().defaultTo(0))
      .execute();

    await db.schema
      .alterTable('imps')

      // awake time before awake_since, which is set while the imp runs
      .addColumn('awake_ms', 'integer', (c) => c.notNull().defaultTo(0))
      .execute();

    // set while the imp runs; a crash leaves it, so the time still counts
    await db.schema.alterTable('imps').addColumn('awake_since', 'integer').execute();
  },
};
