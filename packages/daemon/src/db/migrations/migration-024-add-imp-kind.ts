import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// image builders (#156): an imp impd made for one build, which only rm
// reaches and which goes at the build's end or impd's next start
export const MIGRATION_024_ADD_IMP_KIND: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('imps')
      .addColumn('kind', 'text', (column) => column.notNull().defaultTo('user'))
      .execute();
  },
};
