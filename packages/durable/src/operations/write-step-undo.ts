import type { DurableQueries } from '../durable-tables';
import type { JsonValue } from '../json-value';

interface StepUndo {
  readonly operationId: string;
  readonly position: number;
  readonly record: JsonValue;
}

export async function writeStepUndo(db: DurableQueries, undo: StepUndo): Promise<void> {
  await db
    .updateTable('operation_steps')
    .set({ undo_record: JSON.stringify(undo.record) })
    .where('operation_id', '=', undo.operationId)
    .where('position', '=', undo.position)
    .execute();
}
