import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// a method and path filter on each grant (GEO-283)
export const MIGRATION_031_ADD_GRANT_FILTER: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('grants')

      // the GrantFilter as JSON; null for the whole host, as every grant
      // made before this was
      .addColumn('filter', 'text')
      .execute();
  },
};
