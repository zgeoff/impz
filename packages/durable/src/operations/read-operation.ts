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
  // one statement reads the operation and its steps from one snapshot, so a commit on another
  // connection can't land between them
  const rows = await db
    .selectFrom('operations')
    .innerJoin('operation_steps', 'operation_steps.operation_id', 'operations.id')
    .selectAll('operations')
    .select([
      'operation_steps.position as step_position',
      'operation_steps.name as step_name',
      'operation_steps.state as step_state',
      'operation_steps.started_at as step_started_at',
      'operation_steps.ended_at as step_ended_at',
      'operation_steps.error_code as step_error_code',
      'operation_steps.error_message as step_error_message',
      'operation_steps.undo_record as step_undo_record',
      'operation_steps.undone_at as step_undone_at',
    ])
    .where('operations.id', '=', id)
    .orderBy('operation_steps.position')
    .execute();

  const [first] = rows;

  return first === undefined ? null : toOperation(first, rows);
}

interface JoinedStep {
  readonly step_position: number;
  readonly step_name: string;
  readonly step_state: OperationStepsTable['state'];
  readonly step_started_at: number | null;
  readonly step_ended_at: number | null;
  readonly step_error_code: string | null;
  readonly step_error_message: string | null;
  readonly step_undo_record: string | null;
  readonly step_undone_at: number | null;
}

function toOperation(row: OperationsTable, steps: readonly JoinedStep[]): Operation {
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
      position: step.step_position,
      name: step.step_name,
      state: step.step_state,
      startedAt: step.step_started_at,
      endedAt: step.step_ended_at,
      error: toOperationError(step.step_error_code, step.step_error_message),
      undoRecord: step.step_undo_record === null ? null : parseJson(step.step_undo_record),
      undoneAt: step.step_undone_at,
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
