import type { DurableQueries } from '../durable-tables';
import { appendEvent } from '../events/append-event';
import type { OperationState } from './move-operation';
import type { StepState } from './move-step';
import type { Operation, OperationError } from './read-operation';

export type OperationEventKind = 'operation.started' | 'operation.step' | 'operation.ended';

interface OperationEvent {
  readonly kind: OperationEventKind;
  readonly at: number;
  readonly state: OperationState | StepState;
  readonly step: string | null;
  readonly error: OperationError | null;
}

export async function appendOperationEvent(
  db: DurableQueries,
  operation: Operation,
  event: OperationEvent,
): Promise<void> {
  await appendEvent(db, {
    at: event.at,
    kind: event.kind,
    targetId: operation.targetId,
    operationId: operation.id,
    payload: {
      kind: operation.kind,
      state: event.state,
      step: event.step,
      error: event.error === null ? null : { code: event.error.code, message: event.error.message },
    },
  });
}
