import type { OperationStep } from '../operations/read-operation';

export function buildMockOperationStep(step: Partial<OperationStep> = {}): OperationStep {
  return {
    position: 0,
    name: 'cut',
    state: 'queued',
    startedAt: null,
    endedAt: null,
    error: null,
    undoRecord: null,
    undoneAt: null,
    ...step,
  };
}
