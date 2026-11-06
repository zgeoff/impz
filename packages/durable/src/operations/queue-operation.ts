import type { DurableQueries } from '../durable-tables';
import { appendEvent } from '../events/append-event';
import type { JsonValue } from '../json-value';
import { toCanonicalJson } from '../to-canonical-json';
import type { OperationDefinition } from './define-operation';
import { pickRetryOutcome } from './pick-retry-outcome';

export interface OperationInput<TParams extends JsonValue> {
  readonly params: TParams;
  readonly principal: string;
  readonly targetId: string | null;
  readonly parentId: string | null;
  readonly retryKey: string | null;
}

export interface QueueOutcome {
  readonly kind: 'queued' | 'existing' | 'conflict';
  readonly operationId: string;
}

export async function queueOperation<TParams extends JsonValue, TTrx>(
  db: DurableQueries,
  definition: OperationDefinition<TParams, TTrx>,
  input: OperationInput<TParams> & { readonly now: number },
): Promise<QueueOutcome> {
  const params = toCanonicalJson(input.params);

  const holder =
    input.retryKey === null
      ? undefined
      : await db
          .selectFrom('operations')
          .select(['id', 'kind', 'params', 'target_id', 'principal', 'ended_at'])
          .where('retry_key', '=', input.retryKey)
          .executeTakeFirst();

  if (holder !== undefined) {
    const outcome = pickRetryOutcome(
      {
        kind: holder.kind,
        params: holder.params,
        targetId: holder.target_id,
        principal: holder.principal,
        endedAt: holder.ended_at,
      },
      {
        kind: definition.kind,
        params,
        targetId: input.targetId,
        principal: input.principal,
        now: input.now,
      },
    );

    if (outcome !== 'expired') {
      return { kind: outcome, operationId: holder.id };
    }

    await db
      .updateTable('operations')
      .set({ retry_key: null })
      .where('id', '=', holder.id)
      .execute();
  }

  const operationId = await insertOperation(db, definition, { ...input, params });

  return { kind: 'queued', operationId };
}

async function insertOperation<TParams extends JsonValue, TTrx>(
  db: DurableQueries,
  definition: OperationDefinition<TParams, TTrx>,
  input: Omit<OperationInput<TParams>, 'params'> & {
    readonly params: string;
    readonly now: number;
  },
): Promise<string> {
  const id = Bun.randomUUIDv7('hex', input.now);

  await db
    .insertInto('operations')
    .values({
      id,
      kind: definition.kind,
      target_id: input.targetId,
      parent_id: input.parentId,
      principal: input.principal,
      retry_key: input.retryKey,
      params: input.params,
      state: 'queued',
      current_step: null,
      result: null,
      error_code: null,
      error_message: null,
      ending: null,
      cancel_requested: 0,
      revision: 0,
      created_at: input.now,
      started_at: null,
      ended_at: null,
    })
    .execute();

  await db
    .insertInto('operation_steps')
    .values(
      definition.steps.map((step, position) => ({
        operation_id: id,
        position,
        name: step.name,
        state: 'queued' as const,
        started_at: null,
        ended_at: null,
        error_code: null,
        error_message: null,
        undo_record: null,
        undone_at: null,
      })),
    )
    .execute();

  await appendEvent(db, {
    at: input.now,
    kind: 'operation.queued',
    targetId: input.targetId,
    operationId: id,
    payload: { kind: definition.kind },
  });

  return id;
}
