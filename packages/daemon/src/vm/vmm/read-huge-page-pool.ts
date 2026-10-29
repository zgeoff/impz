import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HUGE_PAGE_MIB = 2;

export interface HugePagePool {
  readonly totalMib: number;
  readonly freeMib: number;
}

// The host reserves the pool through vm.nr_hugepages. A reserved page is free
// but promised to a mapping that has not faulted it in yet, so it counts as
// taken.
export function readHugePagePool(sysRoot = '/sys'): HugePagePool | null {
  const directory = join(sysRoot, 'kernel', 'mm', 'hugepages', 'hugepages-2048kB');

  try {
    const readCount = (name: string): number =>
      Number(readFileSync(join(directory, name), 'utf8').trim());

    const total = readCount('nr_hugepages');
    const free = readCount('free_hugepages') - readCount('resv_hugepages');

    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(free)) {
      return null;
    }

    return { totalMib: total * HUGE_PAGE_MIB, freeMib: Math.max(0, free) * HUGE_PAGE_MIB };
  } catch {
    return null;
  }
}
