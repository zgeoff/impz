import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
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
    onSized: (lockBytes: number) => void,
  ) => Promise<MemoryLockResult>;
  readonly probeCurrent: (target: Readonly<LockTarget>) => boolean;
}

const MIB = 1024 * 1024;

export function createTemplateLocks(deps: TemplateLockDeps): TemplateLocks {
  const locks = new Map<string, MemoryLock>();

  // keyed by build, so a rebuilt template locks apart from the attempt its removed build left
  const locking = createSingleFlight<void>();

  const sizedBytes = new Map<string, number>();

  const state = { isStopping: false };

  const runLock = async (target: Readonly<LockTarget>): Promise<void> => {
    try {
      const result = await deps.lockMemory(target.memFile, (lockBytes) => {
        sizedBytes.set(target.buildId, lockBytes);
      });

      if ('errno' in result) {
        getImpdLogger('boot').warning(
          'boot template {key} memory not locked (errno {errno}): a restore reads what the host dropped',
          { key: target.key.slice(0, 12), errno: String(result.errno) },
        );

        return;
      }

      // the build was removed or replaced while its pages were read in
      if (!deps.probeCurrent(target)) {
        result.lock.release();

        return;
      }

      locks.set(target.key, result.lock);
    } catch (error) {
      getImpdLogger('boot').warning('boot template {key} memory not locked: {error}', {
        key: target.key.slice(0, 12),
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
    readLockedMib: () => {
      const lockedBytes = [...locks.values()].reduce((total, held) => total + held.lockedBytes, 0);
      const sizingBytes = [...sizedBytes.values()].reduce((total, bytes) => total + bytes, 0);

      return Math.ceil((lockedBytes + sizingBytes) / MIB);
    },
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
