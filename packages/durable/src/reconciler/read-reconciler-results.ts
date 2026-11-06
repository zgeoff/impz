import type { DurableQueries } from '../durable-tables';
import type { ReconcilerOutcome } from './define-reconciler';

export interface ReconcilerResult {
  readonly name: string;
  readonly outcome: ReconcilerOutcome;
  readonly summary: string;
  readonly consecutiveErrors: number;
  readonly at: number;
}

export async function readReconcilerResults(db: DurableQueries): Promise<ReconcilerResult[]> {
  const rows = await db.selectFrom('reconcilers').selectAll().orderBy('name').execute();

  return rows.map((row) => ({
    name: row.name,
    outcome: row.outcome,
    summary: row.summary,
    consecutiveErrors: row.consecutive_errors,
    at: row.at,
  }));
}
