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

  return row.last ?? row.pruned_through;
}
