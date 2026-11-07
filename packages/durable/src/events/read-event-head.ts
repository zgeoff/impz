import type { DurableQueries } from '../durable-tables';

export async function readEventHead(db: DurableQueries): Promise<number> {
  const row = await db
    .selectFrom('event_log')
    .select((eb) => [
      'event_log.pruned_through',
      eb
        .selectFrom('events')
        .select((inner) => inner.fn.max('seq').as('last'))
        .as('last'),
    ])
    .where('event_log.id', '=', 1)
    .executeTakeFirstOrThrow();

  // a prune removes by age, so a newer event with an older time can go while an older one stays;
  // a reader started below the prune mark would get a reset on every read
  return Math.max(row.last ?? 0, row.pruned_through);
}
