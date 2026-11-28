import { readFileSync } from 'node:fs';

// A kernel built without transparent huge pages refuses Firecracker's madvise, and the boot fails.
// The file lists the modes with the active one in brackets, and a kernel without them has none.
export function probeTransparentHugePages(
  path = '/sys/kernel/mm/transparent_hugepage/enabled',
): boolean {
  try {
    return !readFileSync(path, 'utf8').includes('[never]');
  } catch {
    return false;
  }
}
