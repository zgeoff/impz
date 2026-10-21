// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import type { LockedImp } from '../../imps/imps/imp-lock';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import type { ImpCheckpointHooks } from '../../imps/imps/imp-service';
import { getErrorMessage } from '../../platform/process/get-error-message';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildInvalidStateError } from '../../surface/api-errors';
import { sendFreeze, sendThaw } from '../agent-client/agent-requests';
import type { StorageBackend } from '../storage/storage-backend';

export const FREEZE_TIMEOUT_MS = 10_000;

export interface DiskFreezer {
  readonly freeze: (vsockPath: string, timeoutMs: number) => Promise<void>;
  readonly thaw: (vsockPath: string) => Promise<void>;
}

interface ConsistentDiskDeps {
  readonly storage: Pick<StorageBackend, 'resolveImpPaths'>;
  readonly imps: Pick<ImpCheckpointHooks, 'requireRunningImp'>;
  readonly log: (message: string) => void;
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

        deps.log(`impd: ${imp.name}: thaw failed (the agent thaws on its own): ${message}`);
      }
    }
  };
}
