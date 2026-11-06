import { once } from 'node:events';
import type { DurableQueries } from '../durable-tables';
import { appendEvent } from '../events/append-event';
import type { JsonValue } from '../json-value';
import { defineOperation } from '../operations/define-operation';
import type {
  OperationDefinition,
  RestartRule,
  StepContext,
  StepDefinition,
  StepOutput,
} from '../operations/define-operation';

export interface RecordingStep {
  readonly name: string;
  readonly onRestart: RestartRule;
  readonly run: 'succeed' | 'fail' | 'hang' | 'wait-for-cancel';
  readonly undo: 'none' | 'succeed' | 'fail' | 'hang';
  readonly writesUndo: boolean;
  readonly result: JsonValue | null;
  readonly writesEvent: string | null;
}

export interface RecordingParams {
  readonly label: string;
  readonly [key: string]: JsonValue;
}

export function buildRecordingOperation(
  kind: string,
  steps: readonly RecordingStep[],
  effects: string[],
): OperationDefinition<RecordingParams> {
  return defineOperation<RecordingParams>({
    kind,
    parseParams: parseRecordingParams,
    steps: Object.fromEntries(steps.map((step) => [step.name, buildStep(step, effects)])),
  });
}

function parseRecordingParams(value: unknown): RecordingParams {
  if (
    typeof value === 'object' &&
    value !== null &&
    'label' in value &&
    typeof value.label === 'string'
  ) {
    return { label: value.label };
  }

  throw new Error(`the params ${JSON.stringify(value)} have no label`);
}

function buildStep(
  step: RecordingStep,
  effects: string[],
): StepDefinition<RecordingParams, DurableQueries> {
  return {
    onRestart: step.onRestart,
    run: (ctx) => runRecordingStep(step, ctx, effects),
    ...(step.undo === 'none'
      ? {}
      : {
          undo: async () => {
            if (step.undo === 'fail') {
              throw new Error(`the undo of ${step.name} failed`);
            }

            effects.push(`undo ${step.name}`);

            if (step.undo === 'hang') {
              await Promise.withResolvers<void>().promise;
            }
          },
        }),
  };
}

async function runRecordingStep(
  step: RecordingStep,
  ctx: StepContext<RecordingParams>,
  effects: string[],
): Promise<StepOutput<DurableQueries>> {
  if (step.writesUndo) {
    await ctx.writeUndo({ step: step.name, label: ctx.params.label });
  }

  if (step.run === 'wait-for-cancel') {
    await once(ctx.signal, 'abort');

    throw new Error(`${step.name} saw the cancel`);
  }

  if (step.run === 'fail') {
    throw new Error(`${step.name} failed`);
  }

  effects.push(step.name);

  if (step.run === 'hang') {
    await Promise.withResolvers<void>().promise;
  }

  return {
    ...(step.result === null ? {} : { result: step.result }),
    ...(step.writesEvent === null ? {} : { write: makeEventWrite(step.writesEvent, ctx) }),
  };
}

function makeEventWrite(
  kind: string,
  ctx: StepContext<RecordingParams>,
): (trx: DurableQueries) => Promise<void> {
  return async (trx) => {
    await appendEvent(trx, {
      at: 0,
      kind,
      targetId: ctx.targetId,
      operationId: ctx.operationId,
      payload: { label: ctx.params.label },
    });
  };
}
