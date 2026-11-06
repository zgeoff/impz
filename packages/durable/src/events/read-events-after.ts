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
  | { readonly kind: 'reset'; readonly prunedThrough: number };

interface ReadEventsAfterInput {
  readonly after: number;
  readonly limit: number;
}

export async function readEventsAfter(
  db: DurableQueries,
  input: ReadEventsAfterInput,
): Promise<EventsAfter> {
  // one statement reads the prune mark and the events from one snapshot, so a prune on another
  // connection can't land between them and hide a gap
  const rows = await db
    .selectFrom('event_log')
    .leftJoin('events', (join) => join.on('events.seq', '>', input.after))
    .select([
      'event_log.pruned_through',
      'events.seq',
      'events.at',
      'events.kind',
      'events.target_id',
      'events.operation_id',
      'events.payload',
    ])
    .where('event_log.id', '=', 1)
    .orderBy('events.seq')
    .limit(input.limit)
    .execute();

  const prunedThrough = rows[0]?.pruned_through ?? 0;

  if (input.after < prunedThrough) {
    return { kind: 'reset', prunedThrough };
  }

  return {
    kind: 'events',
    events: rows.flatMap((row) => (isEventRow(row) ? [toStoredEvent(row)] : [])),
  };
}

interface EventRow {
  readonly seq: number;
  readonly at: number;
  readonly kind: string;
  readonly target_id: string | null;
  readonly operation_id: string | null;
  readonly payload: string;
}

interface JoinedRow {
  readonly seq: number | null;
  readonly at: number | null;
  readonly kind: string | null;
  readonly target_id: string | null;
  readonly operation_id: string | null;
  readonly payload: string | null;
}

// the left join types every event column as nullable, though a row with a seq has them all
function isEventRow(row: JoinedRow): row is EventRow {
  return row.seq !== null && row.at !== null && row.kind !== null && row.payload !== null;
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    targetId: row.target_id,
    operationId: row.operation_id,
    payload: parsePayload(row.payload),
  };
}

function parsePayload(text: string): unknown {
  const payload: unknown = JSON.parse(text);

  return payload;
}
