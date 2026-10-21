import type { Insertable, Selectable, Updateable } from 'kysely';
import type { ImpQueries } from './open-database';
import type { DB } from './schema';

type MoveSendRow = Selectable<DB['move_sends']>;

export function readMoveSend(db: ImpQueries, impId: string): Promise<MoveSendRow | undefined> {
  return db.selectFrom('move_sends').selectAll().where('imp_id', '=', impId).executeTakeFirst();
}

export async function writeMoveSend(
  db: ImpQueries,
  row: Insertable<DB['move_sends']>,
): Promise<void> {
  await db.insertInto('move_sends').values(row).execute();
}

export async function updateMoveSend(
  db: ImpQueries,
  impId: string,
  fields: Updateable<DB['move_sends']>,
): Promise<void> {
  await db.updateTable('move_sends').set(fields).where('imp_id', '=', impId).execute();
}

export async function removeMoveSend(db: ImpQueries, impId: string): Promise<void> {
  await db.deleteFrom('move_sends').where('imp_id', '=', impId).execute();
}
