import type { ImpQueries } from './open-database';

// The slots imps hold, and those that a warm move's live ticket keeps for
// the imp it brings (docs/architecture/storage/moves.md#warm-moves): until the
// commit, once its stream started, else until the stream's start window ends
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
