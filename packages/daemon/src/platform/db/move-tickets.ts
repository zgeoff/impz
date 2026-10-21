import type { Insertable, Selectable, Updateable } from 'kysely';
import type { ImpDatabase, ImpQueries } from './open-database';
import { probeSlotFree } from './probe-slot-free';
import type { DB } from './schema';

export type MoveTicketRow = Selectable<DB['move_tickets']>;

export type NewMoveTicketRow = Insertable<DB['move_tickets']>;

export function readMoveTicket(db: ImpQueries, id: string): Promise<MoveTicketRow | undefined> {
  return db.selectFrom('move_tickets').selectAll().where('id', '=', id).executeTakeFirst();
}

export function readStagedMoveTicket(
  db: ImpQueries,
  impId: string,
): Promise<MoveTicketRow | undefined> {
  return db
    .selectFrom('move_tickets')
    .selectAll()
    .where('imp_id', '=', impId)
    .where('receipt', 'is not', null)
    .executeTakeFirst();
}

export function listMoveTickets(db: ImpQueries): Promise<MoveTicketRow[]> {
  return db.selectFrom('move_tickets').selectAll().execute();
}

export async function writeMoveTicket(db: ImpQueries, row: NewMoveTicketRow): Promise<void> {
  await db.insertInto('move_tickets').values(row).execute();
}

export function createMoveTicketInFreeSlot(
  db: ImpDatabase,
  row: NewMoveTicketRow & { readonly slot: number },
  now: number,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    if (!(await probeSlotFree(trx, row.slot, now))) {
      return false;
    }

    await writeMoveTicket(trx, row);

    return true;
  });
}

export async function updateMoveTicket(
  db: ImpQueries,
  id: string,
  fields: Updateable<DB['move_tickets']>,
): Promise<void> {
  await db.updateTable('move_tickets').set(fields).where('id', '=', id).execute();
}

export async function claimMoveTicketStream(
  db: ImpQueries,
  id: string,
  at: number,
): Promise<boolean> {
  const marked = await db
    .updateTable('move_tickets')
    .set({ stream_used_at: at })
    .where('id', '=', id)
    .where('stream_used_at', 'is', null)
    .executeTakeFirst();

  return marked.numUpdatedRows > 0n;
}

export async function removeMoveTickets(
  db: ImpQueries,
  id: string,
  impId: string | null,
): Promise<void> {
  await db
    .deleteFrom('move_tickets')
    .where((eb) =>
      eb.or([eb('id', '=', id), ...(impId === null ? [] : [eb('imp_id', '=', impId)])]),
    )
    .execute();
}
