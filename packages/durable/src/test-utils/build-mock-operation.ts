import type { Operation } from '../operations/read-operation';

export function buildMockOperation(operation: Partial<Operation> = {}): Operation {
  return {
    id: 'op-1',
    kind: 'shelf.build',
    targetId: null,
    parentId: null,
    principal: 'owner',
    retryKey: null,
    params: { label: 'oak' },
    state: 'running',
    currentStep: null,
    result: null,
    error: null,
    ending: null,
    cancelRequested: false,
    revision: 0,
    createdAt: 1_800_000_000_000,
    startedAt: 1_800_000_000_000,
    endedAt: null,
    steps: [],
    ...operation,
  };
}
