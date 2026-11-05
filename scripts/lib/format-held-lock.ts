export interface HeldLock {
  readonly path: string;
  readonly name: string;
  readonly holder: { readonly pid: number } | null;
}

// the holder writes its record just after it takes the lock, so a lock read
// between the two names no process
export function formatHeldLock(lock: Readonly<HeldLock>): string {
  if (lock.holder === null) {
    return `another process holds the dev instance ${lock.name} (${lock.path})`;
  }

  return `process ${String(lock.holder.pid)} holds the dev instance ${lock.name} (${lock.path})`;
}
