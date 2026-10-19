import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// 016 numbers the jail uids in creation order
interface JailUidSnapshot {
  imps: { id: string; created_at: number; jail_uid: number | null };
}

// a uid per imp for its jailed Firecracker (#27), in order of creation,
// from the start of db/imps.ts JAIL_UIDS
export const MIGRATION_016_ADD_IMP_JAIL_UID: Migration = {
  async up(db: Kysely<JailUidSnapshot>) {
    // the uid and gid its jailed Firecracker runs as (docs/architecture/isolation.md#the-jailer)
    await db.schema.alterTable('imps').addColumn('jail_uid', 'integer').execute();
    await db.schema.createIndex('imps_jail_uid').on('imps').column('jail_uid').unique().execute();

    const rows = await db.selectFrom('imps').select('id').orderBy('created_at').execute();

    for (const [index, row] of rows.entries()) {
      await db
        .updateTable('imps')
        .set({ jail_uid: 900_000 + index })
        .where('id', '=', row.id)
        .execute();
    }
  },
};
