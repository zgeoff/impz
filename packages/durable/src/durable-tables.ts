import type { Generated, Kysely } from 'kysely';
import type { OperationEnding, OperationState } from './operations/move-operation';
import type { StepState } from './operations/move-step';

export interface EventsTable {
  readonly seq: Generated<number>;
  readonly at: number;
  readonly kind: string;
  readonly target_id: string | null;
  readonly operation_id: string | null;
  readonly payload: string;
}

export interface EventLogTable {
  readonly id: number;
  readonly log_id: string;
  readonly pruned_through: number;
}

export interface OperationsTable {
  readonly id: string;
  readonly kind: string;
  readonly target_id: string | null;
  readonly parent_id: string | null;
  readonly principal: string;
  readonly retry_key: string | null;
  readonly params: string;
  readonly state: OperationState;
  readonly current_step: string | null;
  readonly result: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly ending: OperationEnding | null;
  readonly cancel_requested: number;
  readonly revision: number;
  readonly created_at: number;
  readonly started_at: number | null;
  readonly ended_at: number | null;
}

export interface OperationStepsTable {
  readonly operation_id: string;
  readonly position: number;
  readonly name: string;
  readonly state: StepState;
  readonly started_at: number | null;
  readonly ended_at: number | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly undo_record: string | null;
  readonly undone_at: number | null;
}

export interface DurableTables {
  readonly events: EventsTable;
  readonly event_log: EventLogTable;
  readonly operations: OperationsTable;
  readonly operation_steps: OperationStepsTable;
}

// a caller's Transaction<DB> fits this shape where it does not fit Kysely<DurableTables>
export type DurableQueries = Pick<
  Kysely<DurableTables>,
  'selectFrom' | 'insertInto' | 'updateTable' | 'deleteFrom'
>;

// Kysely types isTransaction as true only on a Transaction, so a plain connection fails to fit
export type DurableTransaction = DurableQueries & { readonly isTransaction: true };
