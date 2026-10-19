import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

// 013 copies each imp's hold into a lease of its own
interface ImpLeasesSnapshot {
  imps: { id: string; hold_until: number | null };
  imp_leases: {
    imp_id: string;
    principal: string;
    label: string;
    display: string;
    until: number | null;
    created_at: number;
  };
}

// leases (#96): each owner's own hold on an imp. A hold still live moves to
// the owner `legacy`; hold_until stays, as the latest lease's end.
export const MIGRATION_013_ADD_IMP_LEASES: Migration = {
  async up(db: Kysely<ImpLeasesSnapshot>) {
    // one owner's hold on an imp (docs/guides/leases.md): the principal impd
    // derived for the caller, and a label the caller picked
    await db.schema
      .createTable('imp_leases')
      .addColumn('imp_id', 'text', (c) => c.notNull().references('imps.id').onDelete('cascade'))
      .addColumn('principal', 'text', (c) => c.notNull())
      .addColumn('label', 'text', (c) => c.notNull())

      // the owner as a person reads it, when the lease was written
      .addColumn('display', 'text', (c) => c.notNull())

      // null holds with no end
      .addColumn('until', 'integer')
      .addColumn('created_at', 'integer', (c) => c.notNull())
      .addPrimaryKeyConstraint('imp_leases_pk', ['imp_id', 'principal', 'label'])
      .execute();

    const now = Date.now();

    await db
      .insertInto('imp_leases')
      .columns(['imp_id', 'principal', 'label', 'display', 'until', 'created_at'])
      .expression((eb) =>
        eb
          .selectFrom('imps')
          .select([
            'id',
            eb.val('legacy').as('principal'),
            eb.val('hold').as('label'),
            eb.val('legacy').as('display'),
            'hold_until',
            eb.val(now).as('created_at'),
          ])
          .where('hold_until', '>', now),
      )
      .execute();

    await db.updateTable('imps').set({ hold_until: null }).where('hold_until', '<=', now).execute();
  },
};
