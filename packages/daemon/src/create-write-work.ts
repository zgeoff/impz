import { getErrorMessage } from '@impz/shared';
import { getImpdLogger } from './platform/process/get-impd-logger';

export interface WriteWork {
  readonly run: (work: Promise<unknown> | undefined) => void;
  readonly stop: () => Promise<void>;
}

export function createWriteWork(): WriteWork {
  const pending = new Set<Promise<unknown>>();

  const track = async (work: Promise<unknown>): Promise<void> => {
    pending.add(work);

    try {
      await work;
    } catch (error) {
      getImpdLogger('events').warning('could not follow a database write: {error}', {
        error: getErrorMessage(error),
      });
    } finally {
      pending.delete(work);
    }
  };

  return {
    run: (work) => {
      if (work !== undefined) {
        void track(work);
      }
    },
    stop: async () => {
      await Promise.allSettled(pending);
    },
  };
}
