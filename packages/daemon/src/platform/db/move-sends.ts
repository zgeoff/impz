import type { Insertable, Selectable, Updateable } from 'kysely';
import { MOVE_SEND_STEPS } from './move-send-steps';
import type { MoveSendStep } from './move-send-steps';
import type { ImpDatabase, ImpQueries } from './open-database';
import type { DB } from './schema';

type MoveSendRow = Selectable<DB['move_sends']>;

type MoveSendFields = Omit<Updateable<DB['move_sends']>, 'step'>;

export function readMoveSend(db: ImpQueries, impId: string): Promise<MoveSendRow | undefined> {
  return db.selectFrom('move_sends').selectAll().where('imp_id', '=', impId).executeTakeFirst();
}

export async function writeMoveSend(
  db: ImpQueries,
  row: Omit<Insertable<DB['move_sends']>, 'step'>,
): Promise<void> {
  await db.insertInto('move_sends').values(row).execute();
}

export async function updateMoveSend(
  db: ImpQueries,
  impId: string,
  fields: MoveSendFields,
): Promise<void> {
  await db.updateTable('move_sends').set(fields).where('imp_id', '=', impId).execute();
}

export async function updateMoveSendStep(
  db: ImpDatabase,
  impId: string,
  step: MoveSendStep,
  fields: MoveSendFields = {},
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('move_sends')
      .select('step')
      .where('imp_id', '=', impId)
      .executeTakeFirstOrThrow();

    const from = current.step;
    const isListed = MOVE_SEND_STEPS.some(([each, next]) => each === from && next === step);

    if (from !== step && !isListed) {
      throw new Error(`imp ${impId}: the move send cannot go from ${from} to ${step}`);
    }

    await trx
      .updateTable('move_sends')
      .set({ ...fields, step })
      .where('imp_id', '=', impId)
      .execute();
  });
}

export async function removeMoveSend(db: ImpQueries, impId: string): Promise<void> {
  await db.deleteFrom('move_sends').where('imp_id', '=', impId).execute();
}
