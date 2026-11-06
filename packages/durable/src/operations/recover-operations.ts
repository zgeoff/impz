import { match } from 'ts-pattern';
import type { DurableTransaction } from '../durable-tables';
import type { JsonValue } from '../json-value';
import { appendOperationEvent } from './append-operation-event';
import type { ChangeSignal } from './create-change-signal';
import type { OperationDefinition } from './define-operation';
import { moveOperation } from './move-operation';
import { moveStep } from './move-step';
import { pickRecoveryMove } from './pick-recovery-move';
import type { RecoveryMove } from './pick-recovery-move';
import { readOperation } from './read-operation';
import type { Operation, OperationError, OperationStep } from './read-operation';

interface RecoveryDeps<TTrx extends DurableTransaction> {
  readonly withTransaction: <T>(run: (trx: TTrx) => Promise<T>) => Promise<T>;
  readonly definitions: ReadonlyMap<string, OperationDefinition<JsonValue, TTrx>>;
  readonly changes: ChangeSignal;
  readonly now: () => number;
}

export async function recoverOperations<TTrx extends DurableTransaction>(
  deps: RecoveryDeps<TTrx>,
  run: (id: string) => Promise<void>,
): Promise<void> {
  const open = await deps.withTransaction((trx) =>
    trx
      .selectFrom('operations')
      .select('id')
      .where('state', 'in', ['queued', 'running'])
      .orderBy('created_at')
      .orderBy('id')
      .execute(),
  );

  for (const row of open) {
    const operation = await deps.withTransaction((trx) => readOperation(trx, row.id));

    if (operation !== null) {
      const steps = deps.definitions.get(operation.kind)?.steps ?? [];

      const restartRules = new Map(steps.map((step) => [step.name, step.onRestart]));

      await writeRecoveryMove(deps, operation, pickRecoveryMove(operation, restartRules));
    }
  }

  await Promise.all(open.map((row) => run(row.id)));
}

async function writeRecoveryMove<TTrx extends DurableTransaction>(
  deps: RecoveryDeps<TTrx>,
  operation: Operation,
  move: RecoveryMove,
): Promise<void> {
  await match(move)
    .with({ kind: 'resume' }, () => Promise.resolve())
    .with({ kind: 'fail-step' }, (found) =>
      deps.withTransaction((trx) => writeInterruptedStep(trx, operation, found.step, deps.now())),
    )
    .with({ kind: 'unknown-step' }, (found) =>
      deps.withTransaction((trx) => writeUnknownStep(trx, operation, found.step, deps.now())),
    )
    .exhaustive();

  deps.changes.notify();
}

async function writeInterruptedStep(
  trx: DurableTransaction,
  operation: Operation,
  step: OperationStep,
  at: number,
): Promise<void> {
  const error: OperationError = {
    code: 'interrupted',
    message: `the process stopped during step ${step.name}`,
  };

  await moveStep(trx, {
    operationId: operation.id,
    position: step.position,
    from: 'running',
    to: 'failed',
    set: { ended_at: at, error_code: error.code, error_message: error.message },
  });

  await moveOperation(trx, {
    id: operation.id,
    from: 'running',
    to: 'running',
    set: { ending: 'failed', error_code: error.code, error_message: error.message },
  });

  await appendOperationEvent(trx, operation, {
    kind: 'operation.step',
    at,
    state: 'failed',
    step: step.name,
    error,
  });
}

async function writeUnknownStep(
  trx: DurableTransaction,
  operation: Operation,
  step: OperationStep,
  at: number,
): Promise<void> {
  const error: OperationError = {
    code: 'unknown',
    message: `the effect of step ${step.name} is unknown`,
  };

  await moveStep(trx, {
    operationId: operation.id,
    position: step.position,
    from: 'running',
    to: 'unknown',
    set: { ended_at: at, error_code: error.code, error_message: error.message },
  });

  await moveOperation(trx, {
    id: operation.id,
    from: 'running',
    to: 'unknown',
    set: { ended_at: at, error_code: error.code, error_message: error.message },
  });

  await appendOperationEvent(trx, operation, {
    kind: 'operation.step',
    at,
    state: 'unknown',
    step: step.name,
    error,
  });

  await appendOperationEvent(trx, operation, {
    kind: 'operation.ended',
    at,
    state: 'unknown',
    step: step.name,
    error,
  });
}
