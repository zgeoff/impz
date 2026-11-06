import { getErrorMessage } from '@impz/shared';
import { match } from 'ts-pattern';
import type { JsonValue } from '../json-value';
import type { OperationEnding } from './move-operation';
import type { OperationError } from './read-operation';

export type StepOutcome =
  | { readonly kind: 'effect-failed'; readonly cause: unknown; readonly isAborted: boolean }
  | {
      readonly kind: 'effect-ran';
      readonly hasWrite: boolean;
      readonly result: JsonValue | undefined;
    }
  | { readonly kind: 'commit-failed'; readonly cause: unknown; readonly isAborted: boolean };

export type StepWrite =
  | { readonly kind: 'mark-effect-done' }
  | {
      readonly kind: 'end-step';
      readonly state: 'succeeded' | 'failed';
      readonly error: OperationError | null;
    }
  | { readonly kind: 'run-step-write' }
  | { readonly kind: 'save-result'; readonly result: JsonValue }
  | {
      readonly kind: 'set-ending';
      readonly ending: OperationEnding;
      readonly error: OperationError;
    }
  | {
      readonly kind: 'append-event';
      readonly state: 'succeeded' | 'failed';
      readonly error: OperationError | null;
    };

export function buildStepWrites(outcome: StepOutcome): StepWrite[] {
  return match(outcome)
    .with({ kind: 'effect-ran' }, (ran): StepWrite[] => [
      { kind: 'end-step', state: 'succeeded', error: null },
      ...(ran.hasWrite ? [{ kind: 'run-step-write' } as const] : []),
      ...(ran.result === undefined ? [] : [{ kind: 'save-result', result: ran.result } as const]),
      { kind: 'append-event', state: 'succeeded', error: null },
    ])
    .with({ kind: 'effect-failed' }, { kind: 'commit-failed' }, (failed): StepWrite[] => {
      const error = {
        code: failed.isAborted ? 'cancelled' : 'step_failed',
        message: getErrorMessage(failed.cause),
      };

      return [
        ...(failed.kind === 'commit-failed' ? [{ kind: 'mark-effect-done' } as const] : []),
        { kind: 'end-step', state: 'failed', error },
        { kind: 'set-ending', ending: failed.isAborted ? 'cancelled' : 'failed', error },
        { kind: 'append-event', state: 'failed', error },
      ];
    })
    .exhaustive();
}
