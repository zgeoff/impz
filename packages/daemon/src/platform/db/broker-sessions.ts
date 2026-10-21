import type { ImpDatabase } from './open-database';

export async function probeBrokerSession(
  db: ImpDatabase,
  impId: string,
  generation: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('broker_sessions')
    .select('generation')
    .where('imp_id', '=', impId)
    .where('generation', '=', generation)
    .executeTakeFirst();

  return row !== undefined;
}

export async function writeBrokerSession(
  db: ImpDatabase,
  impId: string,
  generation: string,
  listed: readonly string[],
): Promise<void> {
  const kept = [generation, ...listed];

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('broker_sessions')
      .values({ imp_id: impId, generation, at: Date.now() })
      .onConflict((conflict) => conflict.columns(['imp_id', 'generation']).doNothing())
      .execute();

    await trx
      .deleteFrom('broker_sessions')
      .where('imp_id', '=', impId)
      .where('generation', 'not in', kept)
      .execute();
  });
}
