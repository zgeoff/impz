import type { ImpQueries } from './open-database';

export async function listTakenSlots(db: ImpQueries, now: number): Promise<Set<number>> {
  const imps = await db.selectFrom('imps').select('slot').execute();

  const held = await db
    .selectFrom('move_tickets')
    .select('slot')
    .where('slot', 'is not', null)
    .where('committed_at', 'is', null)
    .where((row) => row.or([row('stream_used_at', 'is not', null), row('stream_by', '>', now)]))
    .execute();

  return new Set([...imps.map((row) => row.slot), ...held.flatMap((row) => row.slot ?? [])]);
}
