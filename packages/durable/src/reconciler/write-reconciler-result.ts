import type { DurableQueries } from '../durable-tables';
import type { ReconcilerResult } from './read-reconciler-results';

export async function writeReconcilerResult(
  db: DurableQueries,
  result: ReconcilerResult,
): Promise<void> {
  const row = {
    name: result.name,
    outcome: result.outcome,
    summary: result.summary,
    consecutive_errors: result.consecutiveErrors,
    at: result.at,
  };

  await db
    .insertInto('reconcilers')
    .values(row)
    .onConflict((conflict) => conflict.column('name').doUpdateSet(row))
    .execute();
}
