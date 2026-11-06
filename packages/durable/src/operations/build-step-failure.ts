import { getErrorMessage } from '@impz/shared';
import type { OperationEnding } from './move-operation';
import type { OperationError } from './read-operation';

interface StepFailureFacts {
  readonly cause: unknown;
  readonly isAborted: boolean;
  readonly phase: 'run' | 'commit';
}

export interface StepFailure {
  readonly ending: OperationEnding;
  readonly error: OperationError;
  readonly isEffectDone: boolean;
}

export function buildStepFailure(facts: StepFailureFacts): StepFailure {
  return {
    ending: facts.isAborted ? 'cancelled' : 'failed',
    error: {
      code: facts.isAborted ? 'cancelled' : 'step_failed',
      message: getErrorMessage(facts.cause),
    },
    isEffectDone: facts.phase === 'commit',
  };
}
