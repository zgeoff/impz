import invariant from 'tiny-invariant';
import type { DurableQueries } from '../durable-tables';
import type { DurableLog, OperationRunner } from '../operations/create-operation-runner';

export type ReconcileOutcome = 'changed' | 'unchanged';

export type ReconcilerOutcome = ReconcileOutcome | 'error';

export interface ReconcileResult {
  readonly outcome: ReconcileOutcome;
  readonly summary: string;
}

export interface ReconcilerContext<TTrx extends DurableQueries> {
  readonly signal: AbortSignal;
  readonly log: DurableLog;
  readonly startOperation: OperationRunner<TTrx>['start'];
}

export interface ReconcilerDefinition<TTrx extends DurableQueries = DurableQueries> {
  readonly name: string;
  readonly intervalMs: number;
  readonly reconcile: (ctx: ReconcilerContext<TTrx>) => Promise<ReconcileResult>;
}

export function defineReconciler<TTrx extends DurableQueries = DurableQueries>(
  definition: ReconcilerDefinition<TTrx>,
): ReconcilerDefinition<TTrx> {
  invariant(definition.name !== '', 'a reconciler needs a name');

  invariant(
    Number.isInteger(definition.intervalMs) && definition.intervalMs > 0,
    `reconciler ${definition.name} needs a whole interval above 0 ms`,
  );

  return definition;
}
