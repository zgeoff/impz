import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// image adds in builder imps (#169): the reference a pull resolved, so an
// add of a moving tag can be traced to the bytes it took
export const MIGRATION_025_ADD_API_AUDIT_DETAIL: Migration = {
  async up(db: Kysely<NoTables>) {
    // what the call resolved that its name does not show: an image add's
    // pulled reference, by digest; null for most calls and older rows
    await db.schema.alterTable('api_audit').addColumn('detail', 'text').execute();
  },
};
