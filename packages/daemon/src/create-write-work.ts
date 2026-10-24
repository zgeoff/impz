import { getErrorMessage } from './platform/process/get-error-message';

export interface WriteWork {
  readonly run: (work: Promise<unknown> | undefined) => void;
  readonly stop: () => Promise<void>;
}

export function createWriteWork(log: (message: string) => void): WriteWork {
  const pending = new Set<Promise<unknown>>();

  const track = async (work: Promise<unknown>): Promise<void> => {
    pending.add(work);

    try {
      await work;
    } catch (error) {
      log(`impd: could not follow a database write: ${getErrorMessage(error)}`);
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
