import type { DurableQueries } from '../durable-tables';
import type { JsonValue } from '../json-value';

export interface NewEvent<TKind extends string = string, TPayload extends JsonValue = JsonValue> {
  readonly at: number;
  readonly kind: TKind;
  readonly targetId: string | null;
  readonly operationId: string | null;
  readonly payload: TPayload;
}

export async function appendEvent(db: DurableQueries, event: NewEvent): Promise<number> {
  const row = await db
    .insertInto('events')
    .values({
      at: event.at,
      kind: event.kind,
      target_id: event.targetId,
      operation_id: event.operationId,
      payload: JSON.stringify(event.payload),
    })
    .returning('seq')
    .executeTakeFirstOrThrow();

  return row.seq;
}
