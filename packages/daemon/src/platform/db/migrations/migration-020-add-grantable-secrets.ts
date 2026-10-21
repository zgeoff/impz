import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

interface GrantableSecretsSnapshot {
  secrets: { name: string; generation: string; value_file: string };
  grants: { secret_name: string; secret_generation: string };
}

export const MIGRATION_020_ADD_GRANTABLE_SECRETS: Migration = {
  async up(db: Kysely<GrantableSecretsSnapshot>) {
    await db.schema
      .alterTable('tokens')

      .addColumn('grantable', 'text', (column) => column.notNull().defaultTo('[]'))
      .execute();

    await db.schema
      .alterTable('secrets')

      .addColumn('generation', 'text', (column) => column.notNull().defaultTo(''))
      .execute();

    await db.schema
      .alterTable('secrets')

      .addColumn('value_file', 'text', (column) => column.notNull().defaultTo(''))
      .execute();

    await db.schema
      .alterTable('grants')

      .addColumn('secret_generation', 'text', (column) => column.notNull().defaultTo(''))
      .execute();

    // randomblob runs once per row
    await db
      .updateTable('secrets')
      .set({ generation: sql`lower(hex(randomblob(16)))`, value_file: sql.ref('name') })
      .execute();

    await db
      .updateTable('grants')
      .set({
        secret_generation: (eb) =>
          eb
            .selectFrom('secrets')
            .select('secrets.generation')
            .whereRef('secrets.name', '=', 'grants.secret_name'),
      })
      .execute();
  },
};
