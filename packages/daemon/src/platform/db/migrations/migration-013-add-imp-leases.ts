import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';

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

export const MIGRATION_013_ADD_IMP_LEASES: Migration = {
  async up(db: Kysely<ImpLeasesSnapshot>) {
    await db.schema
      .createTable('imp_leases')
      .addColumn('imp_id', 'text', (column) =>
        column.notNull().references('imps.id').onDelete('cascade'),
      )
      .addColumn('principal', 'text', (column) => column.notNull())
      .addColumn('label', 'text', (column) => column.notNull())

      .addColumn('display', 'text', (column) => column.notNull())

      .addColumn('until', 'integer')
      .addColumn('created_at', 'integer', (column) => column.notNull())
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
