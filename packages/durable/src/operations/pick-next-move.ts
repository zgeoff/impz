import invariant from 'tiny-invariant';
import type { OperationEnding } from './move-operation';
import type { Operation, OperationStep } from './read-operation';

export type NextMove =
  | { readonly kind: 'done' }
  | { readonly kind: 'cancel-queued' }
  | { readonly kind: 'start' }
  | { readonly kind: 'begin-cancel' }
  | { readonly kind: 'run-step'; readonly step: OperationStep }
  | { readonly kind: 'undo-step'; readonly step: OperationStep }
  | { readonly kind: 'end'; readonly state: 'succeeded' | OperationEnding };

export function pickNextMove(operation: Operation, undoable: ReadonlySet<string>): NextMove {
  if (operation.state === 'queued') {
    return operation.cancelRequested ? { kind: 'cancel-queued' } : { kind: 'start' };
  }

  if (operation.state !== 'running') {
    return { kind: 'done' };
  }

  if (operation.ending !== null) {
    const step = operation.steps.findLast((candidate) => shouldUndo(candidate, undoable));

    return step === undefined
      ? { kind: 'end', state: operation.ending }
      : { kind: 'undo-step', step };
  }

  if (operation.cancelRequested) {
    return { kind: 'begin-cancel' };
  }

  const step = operation.steps.find((candidate) => candidate.state !== 'succeeded');

  if (step === undefined) {
    return { kind: 'end', state: 'succeeded' };
  }

  invariant(
    step.state === 'queued' || step.state === 'running',
    `operation ${operation.id} runs with step ${step.name} ${step.state}`,
  );

  return { kind: 'run-step', step };
}

function shouldUndo(step: OperationStep, undoable: ReadonlySet<string>): boolean {
  if (step.undoneAt !== null || !undoable.has(step.name)) {
    return false;
  }

  return step.state === 'succeeded' || (step.state !== 'queued' && step.undoRecord !== null);
}
