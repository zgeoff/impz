import type { DurableQueries } from '../durable-tables';

export interface StoredEvent {
  readonly seq: number;
  readonly at: number;
  readonly kind: string;
  readonly targetId: string | null;
  readonly operationId: string | null;
  readonly payload: unknown;
}

export type EventsAfter =
  | { readonly kind: 'events'; readonly events: readonly StoredEvent[] }
  | { readonly kind: 'reset' };

interface ReadEventsAfterInput {
  readonly after: number;
  readonly limit: number;
}

export async function readEventsAfter(
  db: DurableQueries,
  input: ReadEventsAfterInput,
): Promise<EventsAfter> {
  const log = await db
    .selectFrom('event_log')
    .select('pruned_through')
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();

  if (input.after < log.pruned_through) {
    return { kind: 'reset' };
  }

  const rows = await db
    .selectFrom('events')
    .selectAll()
    .where('seq', '>', input.after)
    .orderBy('seq')
    .limit(input.limit)
    .execute();

  return {
    kind: 'events',
    events: rows.map((row) => ({
      seq: row.seq,
      at: row.at,
      kind: row.kind,
      targetId: row.target_id,
      operationId: row.operation_id,
      payload: parsePayload(row.payload),
    })),
  };
}

function parsePayload(text: string): unknown {
  const payload: unknown = JSON.parse(text);

  return payload;
}
