import { join } from 'node:path';
import { withFileLock } from '@zgeoff/std/with-file-lock';
import { formatHeldLock } from './format-held-lock.ts';

// The kernel frees the lock when its holder exits, a crash included, so a
// dead bench never blocks the next one.
export async function withDevLock<Value>(
  directory: string,
  name: string,
  run: () => Promise<Value>,
): Promise<Value> {
  const path = join(directory, `impz-dev-${name}.lock`);

  const result = await withFileLock(path, run);

  if (result.kind === 'busy') {
    throw new Error(formatHeldLock({ path, name, holder: result.holder }));
  }

  return result.value;
}
