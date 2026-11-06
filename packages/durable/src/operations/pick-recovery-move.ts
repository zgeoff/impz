import { match } from 'ts-pattern';
import type { RestartRule } from './define-operation';
import type { Operation, OperationStep } from './read-operation';

export type RecoveryMove =
  | { readonly kind: 'resume' }
  | { readonly kind: 'fail-step'; readonly step: OperationStep }
  | { readonly kind: 'unknown-step'; readonly step: OperationStep };

export function pickRecoveryMove(
  operation: Operation,
  restartRules: ReadonlyMap<string, RestartRule>,
): RecoveryMove {
  const step = operation.steps.find((candidate) => candidate.state === 'running');

  if (operation.state !== 'running' || operation.ending !== null || step === undefined) {
    return { kind: 'resume' };
  }

  return match(restartRules.get(step.name) ?? 'rerun')
    .with('rerun', () => ({ kind: 'resume' as const }))
    .with('fail', () => ({ kind: 'fail-step' as const, step }))
    .with('unknown', () => ({ kind: 'unknown-step' as const, step }))
    .exhaustive();
}
