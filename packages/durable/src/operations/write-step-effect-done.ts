import type { DurableQueries } from '../durable-tables';

interface StepRef {
  readonly operationId: string;
  readonly position: number;
}

// a step whose effect ran gets a null undo record, so its undo runs though the step never wrote one
export async function writeStepEffectDone(db: DurableQueries, step: StepRef): Promise<void> {
  await db
    .updateTable('operation_steps')
    .set({ undo_record: JSON.stringify(null) })
    .where('operation_id', '=', step.operationId)
    .where('position', '=', step.position)
    .where('undo_record', 'is', null)
    .execute();
}
