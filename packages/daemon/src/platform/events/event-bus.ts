import type { ImpEvent } from '@impz/api';
import { getErrorMessage } from '../process/get-error-message';
import { printLog } from '../process/print-log';

export interface EventBus<T = Readonly<ImpEvent>> {
  readonly publish: (event: T) => void;

  readonly subscribe: (listener: (event: T) => void) => () => void;
}

export function createEventBus<T = Readonly<ImpEvent>>(
  log: (message: string) => void = printLog,
): EventBus<T> {
  const listeners = new Set<(event: T) => void>();

  return {
    publish: (event) => {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          log(`impd: events: a listener failed: ${getErrorMessage(error)}`);
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}
