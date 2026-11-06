import invariant from 'tiny-invariant';
import type { DurableQueries } from '../durable-tables';
import type { JsonValue } from '../json-value';

export type RestartRule = 'rerun' | 'fail' | 'unknown';

export interface StepContext<TParams> {
  readonly operationId: string;
  readonly targetId: string | null;
  readonly params: TParams;
  readonly signal: AbortSignal;
  readonly undoRecord: unknown;
  readonly writeUndo: (record: JsonValue) => Promise<void>;
}

export interface UndoContext<TParams> {
  readonly operationId: string;
  readonly targetId: string | null;
  readonly params: TParams;
  readonly undoRecord: unknown;
}

export interface StepOutput<TTrx> {
  readonly result?: JsonValue;
  readonly write?: (trx: TTrx) => Promise<void>;
}

export interface StepDefinition<TParams, TTrx> {
  readonly onRestart: RestartRule;
  readonly run: (ctx: StepContext<TParams>) => Promise<StepOutput<TTrx> | undefined>;
  readonly undo?: (ctx: UndoContext<TParams>) => Promise<void>;
}

export interface RunnableStep<TTrx> {
  readonly name: string;
  readonly onRestart: RestartRule;
  readonly run: (ctx: StepContext<unknown>) => Promise<StepOutput<TTrx> | undefined>;
  readonly undo: ((ctx: UndoContext<unknown>) => Promise<void>) | null;
}

export interface OperationDefinition<TParams extends JsonValue, TTrx = DurableQueries> {
  readonly kind: string;
  readonly parseParams: (value: unknown) => TParams;
  readonly steps: readonly RunnableStep<TTrx>[];
}

interface OperationSpec<TParams extends JsonValue, TTrx> {
  readonly kind: string;
  readonly parseParams: (value: unknown) => TParams;
  readonly steps: Readonly<Record<string, StepDefinition<TParams, TTrx>>>;
}

export function defineOperation<TParams extends JsonValue, TTrx = DurableQueries>(
  spec: OperationSpec<TParams, TTrx>,
): OperationDefinition<TParams, TTrx> {
  const steps = Object.entries(spec.steps).map(([name, step]) =>
    toRunnableStep(name, step, spec.parseParams),
  );

  invariant(steps.length > 0, `operation ${spec.kind} has no steps`);

  return { kind: spec.kind, parseParams: spec.parseParams, steps };
}

function toRunnableStep<TParams extends JsonValue, TTrx>(
  name: string,
  step: StepDefinition<TParams, TTrx>,
  parseParams: (value: unknown) => TParams,
): RunnableStep<TTrx> {
  const undo = step.undo;

  return {
    name,
    onRestart: step.onRestart,
    run: (ctx) => step.run({ ...ctx, params: parseParams(ctx.params) }),
    undo: undo === undefined ? null : (ctx) => undo({ ...ctx, params: parseParams(ctx.params) }),
  };
}
