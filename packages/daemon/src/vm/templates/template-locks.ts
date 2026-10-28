import type { Logger } from '@logtape/logtape';
import { match } from 'ts-pattern';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSingleFlight } from '../../platform/process/single-flight';
import { canAdmitLock } from './can-admit-lock';
import type { MemoryLock, MemoryLockResult } from './create-memory-lock';
import { pickLockOutcome } from './pick-lock-outcome';

interface LockTarget {
  readonly key: string;
  readonly buildId: string;
  readonly memFile: string;
}

export interface TemplateLocks {
  readonly lock: (target: Readonly<LockTarget>) => Promise<void>;
  readonly release: (key: string) => void;
  readonly readLockedMib: () => number;
  readonly stop: () => Promise<void>;
}

export interface TemplateLockDeps {
  readonly lockMemory: (
    memFile: string,
    onSized: (lockBytes: number) => boolean,
  ) => Promise<MemoryLockResult>;
  readonly probeCurrent: (target: Readonly<LockTarget>) => boolean;
  readonly ramBudgetMib: number;
  readonly logger: Logger;
}

const MIB = 1024 * 1024;

export function createTemplateLocks(deps: TemplateLockDeps): TemplateLocks {
  const locks = new Map<string, MemoryLock>();

  // keyed by build, so a rebuilt template locks apart from the attempt its removed build left
  const locking = createSingleFlight<void>();

  const sizedBytes = new Map<string, number>();

  const state = { isStopping: false };

  const readHeldBytes = (): number =>
    [...locks.values()].reduce((total, held) => total + held.lockedBytes, 0) +
    [...sizedBytes.values()].reduce((total, bytes) => total + bytes, 0);

  const runLock = async (target: Readonly<LockTarget>): Promise<void> => {
    const key = target.key.slice(0, 12);

    try {
      const result = await deps.lockMemory(target.memFile, (lockBytes) => {
        const isAdmitted = canAdmitLock({
          heldBytes: readHeldBytes(),
          lockBytes,
          ramBudgetMib: deps.ramBudgetMib,
        });

        if (isAdmitted) {
          sizedBytes.set(target.buildId, lockBytes);
        }

        return isAdmitted;
      });

      // a build removed or replaced while its pages were read in is no longer current
      match(pickLockOutcome(result, deps.probeCurrent(target)))
        .with({ kind: 'failed' }, (failed) => {
          deps.logger.warning(
            'boot template {key} memory not locked (errno {errno}): a restore reads what the host dropped',
            { key, errno: String(failed.errno) },
          );
        })
        .with({ kind: 'declined' }, (declined) => {
          deps.logger.info(
            'boot template {key} memory not locked: {lockMib} MiB would take the locks past a tenth of the RAM budget',
            { key, lockMib: String(declined.lockMib) },
          );
        })
        .with({ kind: 'stale' }, (stale) => {
          stale.lock.release();
        })
        .with({ kind: 'held' }, (held) => {
          locks.set(target.key, held.lock);

          deps.logger.info('boot template {key} memory locked: {lockMib} MiB', {
            key,
            lockMib: String(held.lockMib),
          });
        })
        .exhaustive();
    } catch (error) {
      deps.logger.warning('boot template {key} memory not locked: {error}', {
        key,
        error: getErrorMessage(error),
      });
    } finally {
      sizedBytes.delete(target.buildId);
    }
  };

  return {
    lock: (target) =>
      state.isStopping || locks.has(target.key)
        ? Promise.resolve()
        : locking.run(target.buildId, () => runLock(target)),
    release: (key) => {
      locks.get(key)?.release();
      locks.delete(key);
    },
    readLockedMib: () => Math.ceil(readHeldBytes() / MIB),
    stop: async () => {
      state.isStopping = true;

      await locking.waitForAll();

      for (const held of locks.values()) {
        held.release();
      }

      locks.clear();
    },
  };
}
