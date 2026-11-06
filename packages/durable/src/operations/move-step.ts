import type { Updateable } from 'kysely';
import invariant from 'tiny-invariant';
import type { DurableQueries, OperationStepsTable } from '../durable-tables';

export type StepState = 'queued' | 'running' | 'succeeded' | 'failed' | 'unknown';

const STEP_TRANSITIONS: Readonly<Record<StepState, readonly StepState[]>> = {
  queued: ['running'],
  running: ['succeeded', 'failed', 'unknown'],
  succeeded: [],
  failed: [],
  unknown: [],
};

export function canMoveStep(from: StepState, to: StepState): boolean {
  return STEP_TRANSITIONS[from].includes(to);
}

interface StepMove {
  readonly operationId: string;
  readonly position: number;
  readonly from: StepState;
  readonly to: StepState;
  readonly set?: Pick<
    Updateable<OperationStepsTable>,
    'started_at' | 'ended_at' | 'error_code' | 'error_message'
  >;
}

export async function moveStep(db: DurableQueries, move: StepMove): Promise<void> {
  invariant(canMoveStep(move.from, move.to), `a step never moves ${move.from} → ${move.to}`);

  const result = await db
    .updateTable('operation_steps')
    .set({ ...move.set, state: move.to })
    .where('operation_id', '=', move.operationId)
    .where('position', '=', move.position)
    .where('state', '=', move.from)
    .executeTakeFirst();

  invariant(
    result.numUpdatedRows === 1n,
    `step ${move.position} of operation ${move.operationId} is no longer ${move.from}`,
  );
}
