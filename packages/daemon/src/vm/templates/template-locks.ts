import type { Logger } from '@logtape/logtape';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSingleFlight } from '../../platform/process/single-flight';
import type { MemoryLock, MemoryLockResult } from './create-memory-lock';

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

// No sleep frees a locked page, so the locks keep to a share of the RAM budget that leaves the
// imps room to boot and grow on a small host.
const MAX_LOCKED_PERCENT = 10;

export function createTemplateLocks(deps: TemplateLockDeps): TemplateLocks {
  const locks = new Map<string, MemoryLock>();

  // keyed by build, so a rebuilt template locks apart from the attempt its removed build left
  const locking = createSingleFlight<void>();

  const sizedBytes = new Map<string, number>();

  const state = { isStopping: false };
  const maxLockedBytes = Math.floor((deps.ramBudgetMib * MAX_LOCKED_PERCENT) / 100) * MIB;

  const readHeldBytes = (): number =>
    [...locks.values()].reduce((total, held) => total + held.lockedBytes, 0) +
    [...sizedBytes.values()].reduce((total, bytes) => total + bytes, 0);

  const runLock = async (target: Readonly<LockTarget>): Promise<void> => {
    const key = target.key.slice(0, 12);

    try {
      const result = await deps.lockMemory(target.memFile, (lockBytes) => {
        if (readHeldBytes() + lockBytes > maxLockedBytes) {
          return false;
        }

        sizedBytes.set(target.buildId, lockBytes);

        return true;
      });

      if ('errno' in result) {
        deps.logger.warning(
          'boot template {key} memory not locked (errno {errno}): a restore reads what the host dropped',
          { key, errno: String(result.errno) },
        );

        return;
      }

      if ('declinedBytes' in result) {
        deps.logger.info(
          'boot template {key} memory not locked: {lockMib} MiB would pass the {maxMib} MiB that locks may hold',
          {
            key,
            lockMib: String(Math.ceil(result.declinedBytes / MIB)),
            maxMib: String(maxLockedBytes / MIB),
          },
        );

        return;
      }

      // the build was removed or replaced while its pages were read in
      if (!deps.probeCurrent(target)) {
        result.lock.release();

        return;
      }

      locks.set(target.key, result.lock);

      deps.logger.info('boot template {key} memory locked: {lockMib} MiB', {
        key,
        lockMib: String(Math.ceil(result.lock.lockedBytes / MIB)),
      });
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
