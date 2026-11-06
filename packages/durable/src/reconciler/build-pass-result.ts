import type { ReconcilerResult } from './read-reconciler-results';

interface PassInput {
  readonly name: string;
  readonly passed: Pick<ReconcilerResult, 'outcome' | 'summary'>;
  readonly consecutiveErrors: number;
  readonly savedOutcome: ReconcilerResult['outcome'] | null;
  readonly now: number;
}

export interface PassResult {
  readonly result: ReconcilerResult;
  readonly shouldSave: boolean;
}

export function buildPassResult(input: PassInput): PassResult {
  return {
    result: {
      name: input.name,
      outcome: input.passed.outcome,
      summary: input.passed.summary,
      consecutiveErrors: input.passed.outcome === 'error' ? input.consecutiveErrors + 1 : 0,
      at: input.now,
    },
    shouldSave: input.savedOutcome !== input.passed.outcome,
  };
}
