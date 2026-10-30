export interface HeldLock {
  readonly path: string;
  readonly name: string;
  readonly holder: { readonly pid: number; readonly isAlive: boolean } | null;
}

// the holder can release between a failed take and the read of its file,
// which reads as a lock that names no process
export function formatHeldLock(lock: Readonly<HeldLock>): string {
  if (lock.holder === null) {
    return `the lock on the dev instance ${lock.name} names no process; remove ${lock.path} once no bench runs`;
  }

  const pid = String(lock.holder.pid);

  if (lock.holder.isAlive) {
    return `process ${pid} holds the dev instance ${lock.name} (${lock.path})`;
  }

  return `process ${pid} has exited but left the lock on the dev instance ${lock.name}; remove ${lock.path} once no bench runs`;
}
