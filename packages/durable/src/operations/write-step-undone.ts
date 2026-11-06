import type { DurableQueries } from '../durable-tables';

interface StepUndone {
  readonly operationId: string;
  readonly position: number;
  readonly at: number;
}

export async function writeStepUndone(db: DurableQueries, undone: StepUndone): Promise<void> {
  await db
    .updateTable('operation_steps')
    .set({ undone_at: undone.at })
    .where('operation_id', '=', undone.operationId)
    .where('position', '=', undone.position)
    .execute();
}
