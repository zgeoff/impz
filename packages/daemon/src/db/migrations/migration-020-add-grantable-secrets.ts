import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// 020 gives each secret a generation and value file, and each grant its
// secret's generation
interface GrantableSecretsSnapshot {
  secrets: { name: string; generation: string; value_file: string };
  grants: { secret_name: string; secret_generation: string };
}

// tokens that may grant (#126): the secrets, each by name and generation;
// each grant's generation; and the file with each value. Existing values
// are in files named after their secrets.
export const MIGRATION_020_ADD_GRANTABLE_SECRETS: Migration = {
  async up(db: Kysely<GrantableSecretsSnapshot>) {
    await db.schema
      .alterTable('tokens')

      // a JSON array of { name, generation }: the secrets it may grant to its
      // imps. Set at create, and changed only by tokens.update; a non-empty
      // list also marks a token able to grant.
      .addColumn('grantable', 'text', (c) => c.notNull().defaultTo('[]'))
      .execute();

    await db.schema
      .alterTable('secrets')

      // random, set on create and kept by a rotation; a rebind or a delete and
      // create gives another (docs/guides/connectors.md#rotate-or-rebind)
      .addColumn('generation', 'text', (c) => c.notNull().defaultTo(''))
      .execute();

    await db.schema
      .alterTable('secrets')

      // the file in <dataDir>/secrets that holds the value; a replace writes a
      // new one and switches to it with the rules
      .addColumn('value_file', 'text', (c) => c.notNull().defaultTo(''))
      .execute();

    await db.schema
      .alterTable('grants')

      // the secret's generation at the grant: a rebind gives the secret another,
      // and a grant counts only while the two match
      .addColumn('secret_generation', 'text', (c) => c.notNull().defaultTo(''))
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
