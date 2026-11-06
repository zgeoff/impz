import type { DurableQueries, OperationStepsTable, OperationsTable } from '../durable-tables';
import type { OperationEnding, OperationState } from './move-operation';
import type { StepState } from './move-step';

export interface OperationError {
  readonly code: string;
  readonly message: string;
}

export interface OperationStep {
  readonly position: number;
  readonly name: string;
  readonly state: StepState;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly error: OperationError | null;
  readonly undoRecord: unknown;
  readonly undoneAt: number | null;
}

export interface Operation {
  readonly id: string;
  readonly kind: string;
  readonly targetId: string | null;
  readonly parentId: string | null;
  readonly principal: string;
  readonly retryKey: string | null;
  readonly params: unknown;
  readonly state: OperationState;
  readonly currentStep: string | null;
  readonly result: unknown;
  readonly error: OperationError | null;
  readonly ending: OperationEnding | null;
  readonly cancelRequested: boolean;
  readonly revision: number;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly steps: readonly OperationStep[];
}

export async function readOperation(db: DurableQueries, id: string): Promise<Operation | null> {
  const row = await db.selectFrom('operations').selectAll().where('id', '=', id).executeTakeFirst();

  if (row === undefined) {
    return null;
  }

  const steps = await db
    .selectFrom('operation_steps')
    .selectAll()
    .where('operation_id', '=', id)
    .orderBy('position')
    .execute();

  return toOperation(row, steps);
}

function toOperation(row: OperationsTable, steps: readonly OperationStepsTable[]): Operation {
  return {
    id: row.id,
    kind: row.kind,
    targetId: row.target_id,
    parentId: row.parent_id,
    principal: row.principal,
    retryKey: row.retry_key,
    params: parseJson(row.params),
    state: row.state,
    currentStep: row.current_step,
    result: row.result === null ? null : parseJson(row.result),
    error: toOperationError(row.error_code, row.error_message),
    ending: row.ending,
    cancelRequested: row.cancel_requested === 1,
    revision: row.revision,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    steps: steps.map((step) => ({
      position: step.position,
      name: step.name,
      state: step.state,
      startedAt: step.started_at,
      endedAt: step.ended_at,
      error: toOperationError(step.error_code, step.error_message),
      undoRecord: step.undo_record === null ? null : parseJson(step.undo_record),
      undoneAt: step.undone_at,
    })),
  };
}

function parseJson(text: string): unknown {
  const value: unknown = JSON.parse(text);

  return value;
}

function toOperationError(code: string | null, message: string | null): OperationError | null {
  return code === null || message === null ? null : { code, message };
}
