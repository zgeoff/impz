import { buildInvalidStateError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { sendFreeze, sendThaw } from '../../vm/agent-client/agent-requests';
import type { StorageBackend } from '../../vm/storage/storage-backend';
import type { LockedImp } from './imp-lock';
import type { ImpCheckpointHooks } from './imp-service';

export const FREEZE_TIMEOUT_MS = 10_000;

export interface DiskFreezer {
  readonly freeze: (vsockPath: string, timeoutMs: number) => Promise<void>;
  readonly thaw: (vsockPath: string) => Promise<void>;
}

interface ConsistentDiskDeps {
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly imps: Pick<ImpCheckpointHooks, 'requireRunningImp'>;
  readonly freezer?: DiskFreezer | undefined;
}

export type WithConsistentDisk = <T>(
  found: LockedImp,
  action: string,
  task: () => Promise<T>,
) => Promise<T>;

export function createConsistentDisk(deps: ConsistentDiskDeps): WithConsistentDisk {
  const freezer = deps.freezer ?? { freeze: sendFreeze, thaw: sendThaw };

  return async (found, action, task) => {
    const paths = deps.storage.resolveImpPaths(found.id);

    if (found.state === 'stopped' || found.state === 'error') {
      return task();
    }

    // A sleeping guest wakes first, because its memory snapshot holds page cache it has not yet
    // written to the disk.
    const imp = found.state === 'sleeping' ? await deps.imps.requireRunningImp(found) : found;

    if (imp.state !== 'running') {
      throw buildInvalidStateError(imp.state, ['running', 'stopped', 'error'], action);
    }

    try {
      await freezer.freeze(paths.vsockSocket, FREEZE_TIMEOUT_MS);

      return await task();
    } finally {
      try {
        await freezer.thaw(paths.vsockSocket);
      } catch (error) {
        const message = getErrorMessage(error);

        getImpdLogger('imps')
          .with({ imp: imp.name })
          .warning('thaw failed (the agent thaws on its own): {message}', { message });
      }
    }
  };
}
