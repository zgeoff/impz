import type { Updateable } from 'kysely';
import invariant from 'tiny-invariant';
import type { DurableQueries, OperationsTable } from '../durable-tables';

export type OperationState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export type OperationEnding = 'failed' | 'cancelled';

const OPERATION_TRANSITIONS: Readonly<Record<OperationState, readonly OperationState[]>> = {
  queued: ['running', 'failed', 'cancelled'],
  running: ['running', 'succeeded', 'failed', 'cancelled', 'unknown'],
  succeeded: [],
  failed: [],
  cancelled: [],
  unknown: [],
};

export function canMoveOperation(from: OperationState, to: OperationState): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

interface OperationMove {
  readonly id: string;
  readonly from: OperationState;
  readonly to: OperationState;
  readonly set?: Omit<Updateable<OperationsTable>, 'id' | 'state' | 'revision'>;
}

export async function moveOperation(db: DurableQueries, move: OperationMove): Promise<void> {
  invariant(
    canMoveOperation(move.from, move.to),
    `an operation never moves ${move.from} → ${move.to}`,
  );

  const result = await db
    .updateTable('operations')
    .set((eb) => ({ ...move.set, state: move.to, revision: eb('revision', '+', 1) }))
    .where('id', '=', move.id)
    .where('state', '=', move.from)
    .executeTakeFirst();

  invariant(result.numUpdatedRows === 1n, `operation ${move.id} is no longer ${move.from}`);
}
