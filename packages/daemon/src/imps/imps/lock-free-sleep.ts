import type { TryResult } from '../../platform/process/keyed-mutex';

export type SleepOutcome = 'slept' | 'skipped' | 'failed' | 'diskFull';

export type SleepPolicy =
  | { readonly by: 'governor' }
  | { readonly by: 'idle'; readonly seenActiveAt: number };

// The governor calls this while it holds admission, which a boot under the
// imp's lock may wait for, so waiting on the lock here would deadlock.
export type LockFreeSleep = (
  id: string,
  reason: string,
  policy: SleepPolicy,
) => Promise<SleepOutcome>;

export function makeLockFreeSleep<T>(
  tryLock: (
    id: string,
    action: (held: T) => Promise<SleepOutcome>,
  ) => Promise<TryResult<SleepOutcome>>,
  sleep: (held: T, reason: string, policy: SleepPolicy) => Promise<SleepOutcome>,
): LockFreeSleep {
  return async (id, reason, policy) => {
    const result = await tryLock(id, (held) => sleep(held, reason, policy));

    return result.ran ? result.value : 'skipped';
  };
}
