import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// tokens that add their own images (GEO-498)
export const MIGRATION_029_ADD_TOKEN_IMAGE_REF_PREFIX: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.schema
      .alterTable('tokens')

      // the start every image ref the token adds must have, such as
      // ghcr.io/org/app-; null for a token that adds no image
      .addColumn('image_ref_prefix', 'text')
      .execute();
  },
};
