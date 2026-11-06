import { getErrorMessage } from '@impz/shared';
import invariant from 'tiny-invariant';
import { match } from 'ts-pattern';
import type { DurableQueries } from '../durable-tables';
import type { JsonValue } from '../json-value';
import { appendOperationEvent } from './append-operation-event';
import type { ChangeSignal } from './create-change-signal';
import type { OperationDefinition, RunnableStep } from './define-operation';
import { moveOperation } from './move-operation';
import { moveStep } from './move-step';
import { pickNextMove } from './pick-next-move';
import type { NextMove } from './pick-next-move';
import { queueOperation } from './queue-operation';
import type { OperationInput, QueueOutcome } from './queue-operation';
import { readOperation } from './read-operation';
import type { Operation, OperationError, OperationStep } from './read-operation';
import { recoverOperations } from './recover-operations';
import { writeCancelRequest } from './write-cancel-request';
import { writeStepUndo } from './write-step-undo';
import { writeStepUndone } from './write-step-undone';

export interface DurableLog {
  readonly warning: (message: string, properties: Readonly<Record<string, unknown>>) => void;
}

export interface OperationRunnerDeps<TTrx extends DurableQueries> {
  readonly withTransaction: <T>(run: (trx: TTrx) => Promise<T>) => Promise<T>;
  readonly definitions: readonly OperationDefinition<JsonValue, TTrx>[];
  readonly changes: ChangeSignal;
  readonly now: () => number;
  readonly log: DurableLog;
}

export interface OperationRunner<TTrx extends DurableQueries> {
  readonly start: <TParams extends JsonValue>(
    definition: OperationDefinition<TParams, TTrx>,
    input: OperationInput<TParams>,
  ) => Promise<QueueOutcome>;
  readonly run: (id: string) => Promise<void>;
  readonly cancel: (id: string) => Promise<void>;
  readonly recover: () => Promise<void>;
}

interface ActiveRun {
  readonly promise: Promise<void>;
  readonly controller: AbortController;
}

export function createOperationRunner<TTrx extends DurableQueries>(
  deps: OperationRunnerDeps<TTrx>,
): OperationRunner<TTrx> {
  const definitions = new Map(deps.definitions.map((definition) => [definition.kind, definition]));
  const active = new Map<string, ActiveRun>();

  const commit = async (write: (trx: TTrx) => Promise<void>): Promise<void> => {
    await deps.withTransaction(write);

    deps.changes.notify();
  };

  const run = (id: string): Promise<void> => {
    const current = active.get(id);

    if (current !== undefined) {
      return current.promise;
    }

    const controller = new AbortController();

    const promise = runAndRelease(id, controller.signal);

    active.set(id, { promise, controller });

    return promise;
  };

  const runAndRelease = async (id: string, signal: AbortSignal): Promise<void> => {
    try {
      await runToEnd(id, signal);
    } finally {
      active.delete(id);
    }
  };

  const runInBackground = async (id: string): Promise<void> => {
    try {
      await run(id);
    } catch (error) {
      deps.log.warning('operation {operationId} stopped: {error}', {
        operationId: id,
        error: getErrorMessage(error),
      });
    }
  };

  const runToEnd = async (id: string, signal: AbortSignal): Promise<void> => {
    for (;;) {
      const operation = await deps.withTransaction((trx) => readOperation(trx, id));

      if (operation === null) {
        return;
      }

      const definition = definitions.get(operation.kind);

      if (definition === undefined) {
        await endUnknownKind(operation);

        return;
      }

      const move = pickNextMove(operation, collectUndoable(definition.steps));

      if (move.kind === 'done') {
        return;
      }

      await applyMove(operation, definition, move, signal);
    }
  };

  const endUnknownKind = async (operation: Operation): Promise<void> => {
    if (operation.state !== 'queued' && operation.state !== 'running') {
      return;
    }

    const error = {
      code: 'unknown_kind',
      message: `no operation of kind ${operation.kind} is defined`,
    };

    await commit(async (trx) => {
      await moveOperation(trx, {
        id: operation.id,
        from: operation.state,
        to: 'failed',
        set: { ended_at: deps.now(), error_code: error.code, error_message: error.message },
      });

      await appendOperationEvent(trx, operation, {
        kind: 'operation.ended',
        at: deps.now(),
        state: 'failed',
        step: null,
        error,
      });
    });
  };

  const applyMove = (
    operation: Operation,
    definition: OperationDefinition<JsonValue, TTrx>,
    move: Exclude<NextMove, { readonly kind: 'done' }>,
    signal: AbortSignal,
  ): Promise<void> =>
    match(move)
      .with({ kind: 'cancel-queued' }, () =>
        endOperation(operation, 'queued', 'cancelled', {
          code: 'cancelled',
          message: 'the operation was cancelled before it started',
        }),
      )
      .with({ kind: 'start' }, () =>
        commit(async (trx) => {
          await moveOperation(trx, {
            id: operation.id,
            from: 'queued',
            to: 'running',
            set: { started_at: deps.now() },
          });

          await appendOperationEvent(trx, operation, {
            kind: 'operation.started',
            at: deps.now(),
            state: 'running',
            step: null,
            error: null,
          });
        }),
      )
      .with({ kind: 'begin-cancel' }, () =>
        commit((trx) =>
          moveOperation(trx, {
            id: operation.id,
            from: 'running',
            to: 'running',
            set: {
              ending: 'cancelled',
              error_code: 'cancelled',
              error_message: 'the operation was cancelled',
            },
          }),
        ),
      )
      .with({ kind: 'run-step' }, (found) =>
        runStep(operation, getRunnableStep(definition, found.step), found.step, signal),
      )
      .with({ kind: 'undo-step' }, (found) =>
        undoStep(operation, getRunnableStep(definition, found.step), found.step),
      )
      .with({ kind: 'end' }, (found) =>
        endOperation(operation, 'running', found.state, operation.error),
      )
      .exhaustive();

  const runStep = async (
    operation: Operation,
    runnable: RunnableStep<TTrx>,
    step: OperationStep,
    signal: AbortSignal,
  ): Promise<void> => {
    if (step.state === 'queued') {
      await commit(async (trx) => {
        await moveStep(trx, {
          operationId: operation.id,
          position: step.position,
          from: 'queued',
          to: 'running',
          set: { started_at: deps.now() },
        });

        await moveOperation(trx, {
          id: operation.id,
          from: 'running',
          to: 'running',
          set: { current_step: step.name },
        });

        await appendOperationEvent(trx, operation, {
          kind: 'operation.step',
          at: deps.now(),
          state: 'running',
          step: step.name,
          error: null,
        });
      });
    }

    try {
      const output = await runnable.run({
        operationId: operation.id,
        targetId: operation.targetId,
        params: operation.params,
        signal,
        undoRecord: step.undoRecord,
        writeUndo: (record) =>
          commit((trx) =>
            writeStepUndo(trx, { operationId: operation.id, position: step.position, record }),
          ),
      });

      await commit(async (trx) => {
        await moveStep(trx, {
          operationId: operation.id,
          position: step.position,
          from: 'running',
          to: 'succeeded',
          set: { ended_at: deps.now() },
        });

        await output?.write?.(trx);

        if (output?.result !== undefined) {
          await moveOperation(trx, {
            id: operation.id,
            from: 'running',
            to: 'running',
            set: { result: JSON.stringify(output.result) },
          });
        }

        await appendOperationEvent(trx, operation, {
          kind: 'operation.step',
          at: deps.now(),
          state: 'succeeded',
          step: step.name,
          error: null,
        });
      });
    } catch (error) {
      const ending = signal.aborted ? 'cancelled' : 'failed';

      await failStep(operation, step, ending, {
        code: signal.aborted ? 'cancelled' : 'step_failed',
        message: getErrorMessage(error),
      });
    }
  };

  const failStep = (
    operation: Operation,
    step: OperationStep,
    ending: 'failed' | 'cancelled',
    error: OperationError,
  ): Promise<void> =>
    commit(async (trx) => {
      await moveStep(trx, {
        operationId: operation.id,
        position: step.position,
        from: 'running',
        to: 'failed',
        set: { ended_at: deps.now(), error_code: error.code, error_message: error.message },
      });

      await moveOperation(trx, {
        id: operation.id,
        from: 'running',
        to: 'running',
        set: { ending, error_code: error.code, error_message: error.message },
      });

      await appendOperationEvent(trx, operation, {
        kind: 'operation.step',
        at: deps.now(),
        state: 'failed',
        step: step.name,
        error,
      });
    });

  const undoStep = async (
    operation: Operation,
    runnable: RunnableStep<TTrx>,
    step: OperationStep,
  ): Promise<void> => {
    invariant(runnable.undo !== null, `step ${step.name} has no undo`);

    try {
      await runnable.undo({
        operationId: operation.id,
        targetId: operation.targetId,
        params: operation.params,
        undoRecord: step.undoRecord,
      });
    } catch (error) {
      deps.log.warning('the undo of step {step} of operation {operationId} failed: {error}', {
        step: step.name,
        operationId: operation.id,
        error: getErrorMessage(error),
      });

      await endOperation(operation, 'running', 'failed', {
        code: 'undo_failed',
        message: `the undo of step ${step.name} failed: ${getErrorMessage(error)}`,
      });

      return;
    }

    await commit((trx) =>
      writeStepUndone(trx, { operationId: operation.id, position: step.position, at: deps.now() }),
    );
  };

  const endOperation = (
    operation: Operation,
    from: 'queued' | 'running',
    to: 'succeeded' | 'failed' | 'cancelled',
    error: OperationError | null,
  ): Promise<void> =>
    commit(async (trx) => {
      await moveOperation(trx, {
        id: operation.id,
        from,
        to,
        set: {
          ended_at: deps.now(),
          current_step: to === 'succeeded' ? null : operation.currentStep,
          error_code: error?.code ?? null,
          error_message: error?.message ?? null,
        },
      });

      await appendOperationEvent(trx, operation, {
        kind: 'operation.ended',
        at: deps.now(),
        state: to,
        step: null,
        error,
      });
    });

  return {
    start: async (definition, input) => {
      invariant(
        definitions.get(definition.kind) === definition,
        `operation ${definition.kind} is not one of the runner's definitions`,
      );

      const outcome = await deps.withTransaction((trx) =>
        queueOperation(trx, definition, { ...input, now: deps.now() }),
      );

      deps.changes.notify();

      if (outcome.kind === 'queued') {
        void runInBackground(outcome.operationId);
      }

      return outcome;
    },
    run,
    cancel: async (id) => {
      await commit(async (trx) => {
        await writeCancelRequest(trx, id);
      });

      active.get(id)?.controller.abort();
    },
    recover: () => recoverOperations({ ...deps, definitions }, run),
  };
}

function collectUndoable<TTrx>(steps: readonly RunnableStep<TTrx>[]): ReadonlySet<string> {
  return new Set(steps.filter((step) => step.undo !== null).map((step) => step.name));
}

function getRunnableStep<TTrx>(
  definition: OperationDefinition<JsonValue, TTrx>,
  step: OperationStep,
): RunnableStep<TTrx> {
  const runnable = definition.steps[step.position];

  invariant(
    runnable?.name === step.name,
    `operation ${definition.kind} has no step ${step.name} at position ${step.position}`,
  );

  return runnable;
}
