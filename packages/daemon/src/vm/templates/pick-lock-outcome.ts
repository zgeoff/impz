import { P, match } from 'ts-pattern';
import type { MemoryLock, MemoryLockResult } from './create-memory-lock';

type LockOutcome =
  | { readonly kind: 'failed'; readonly errno: number }
  | { readonly kind: 'declined'; readonly lockMib: number }
  | { readonly kind: 'stale'; readonly lock: MemoryLock }
  | { readonly kind: 'held'; readonly lock: MemoryLock; readonly lockMib: number };

const MIB = 1024 * 1024;

export function pickLockOutcome(result: MemoryLockResult, isCurrent: boolean): LockOutcome {
  return match(result)
    .with({ errno: P.number }, (failed): LockOutcome => ({ kind: 'failed', errno: failed.errno }))
    .with({ declinedBytes: P.number }, (declined): LockOutcome => ({
      kind: 'declined',
      lockMib: Math.ceil(declined.declinedBytes / MIB),
    }))
    .with({ lock: P.select() }, (lock): LockOutcome =>
      isCurrent
        ? { kind: 'held', lock, lockMib: Math.ceil(lock.lockedBytes / MIB) }
        : { kind: 'stale', lock },
    )
    .exhaustive();
}
