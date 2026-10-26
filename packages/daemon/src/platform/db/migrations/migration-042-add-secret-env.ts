import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

interface SecretEnvSnapshot {
  secrets: { kind: string; env: string };
}

// A copy, so a later change to a preset leaves the rows this wrote alone.
const PRESET_ENV: Readonly<Record<string, readonly string[]>> = {
  github: ['GH_TOKEN', 'GITHUB_TOKEN'],
  anthropic: ['ANTHROPIC_API_KEY'],
  npm: ['NPM_TOKEN'],
};

export const MIGRATION_042_ADD_SECRET_ENV: Migration = {
  async up(db: Kysely<SecretEnvSnapshot>) {
    await db.schema
      .alterTable('secrets')

      .addColumn('env', 'text', (column) => column.notNull().defaultTo('[]'))
      .execute();

    for (const [kind, env] of Object.entries(PRESET_ENV)) {
      await db
        .updateTable('secrets')
        .set({ env: JSON.stringify(env) })
        .where('kind', '=', kind)
        .execute();
    }
  },
};
