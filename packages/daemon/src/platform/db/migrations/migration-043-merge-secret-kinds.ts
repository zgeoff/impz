import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

interface SecretKindsSnapshot {
  secrets: { kind: string };
}

// A preset row keeps the rules and the variables its preset gave it, so only
// the kind changes.
export const MIGRATION_043_MERGE_SECRET_KINDS: Migration = {
  async up(db: Kysely<SecretKindsSnapshot>) {
    await db
      .updateTable('secrets')
      .set({ kind: 'static' })
      .where('kind', 'in', ['github', 'anthropic', 'npm', 'custom'])
      .execute();
  },
};
