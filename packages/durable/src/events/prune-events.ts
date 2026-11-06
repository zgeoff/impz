import type { ExpressionBuilder } from 'kysely';
import type { DurableQueries, DurableTables } from '../durable-tables';

const EVENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT_MAX_ROWS = 100_000;

export async function pruneEvents(db: DurableQueries, now: number): Promise<number> {
  const oldestKept = await db
    .selectFrom('events')
    .select('seq')
    .orderBy('seq', 'desc')
    .offset(EVENT_MAX_ROWS - 1)
    .limit(1)
    .executeTakeFirst();

  const isExpired = (eb: ExpressionBuilder<DurableTables, 'events'>) =>
    eb.or([eb('at', '<', now - EVENT_MAX_AGE_MS), eb('seq', '<', oldestKept?.seq ?? 0)]);

  const last = await db
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where(isExpired)
    .executeTakeFirstOrThrow();

  if (last.seq === null) {
    return 0;
  }

  const removed = await db.deleteFrom('events').where(isExpired).executeTakeFirstOrThrow();

  await db
    .updateTable('event_log')
    .set((eb) => ({ pruned_through: eb.fn('max', ['pruned_through', eb.val(last.seq)]) }))
    .where('id', '=', 1)
    .execute();

  return Number(removed.numDeletedRows);
}
