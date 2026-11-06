import type { DurableTransaction } from '../durable-tables';
import { EVENT_MAX_AGE_MS, EVENT_MAX_ROWS, pickPrunePlan } from './pick-prune-plan';

export async function pruneEvents(trx: DurableTransaction, now: number): Promise<number> {
  const oldestKept = await trx
    .selectFrom('events')
    .select('seq')
    .orderBy('seq', 'desc')
    .offset(EVENT_MAX_ROWS - 1)
    .limit(1)
    .executeTakeFirst();

  const oldestKeptSeq = oldestKept?.seq ?? null;

  const lastAged = await trx
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('at', '<', now - EVENT_MAX_AGE_MS)
    .executeTakeFirstOrThrow();

  const lastCounted = await trx
    .selectFrom('events')
    .select((eb) => eb.fn.max('seq').as('seq'))
    .where('seq', '<', oldestKeptSeq ?? 0)
    .executeTakeFirstOrThrow();

  const plan = pickPrunePlan({
    now,
    oldestKeptSeq,
    lastAgedSeq: lastAged.seq,
    lastCountedSeq: lastCounted.seq,
  });

  if (plan.kind === 'none') {
    return 0;
  }

  const removed = await trx
    .deleteFrom('events')
    .where((eb) => eb.or([eb('at', '<', plan.beforeAt), eb('seq', '<', plan.belowSeq)]))
    .executeTakeFirstOrThrow();

  await trx
    .updateTable('event_log')
    .set((eb) => ({ pruned_through: eb.fn('max', ['pruned_through', eb.val(plan.prunedThrough)]) }))
    .where('id', '=', 1)
    .execute();

  return Number(removed.numDeletedRows);
}
