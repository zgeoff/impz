import type { HugePages } from '../../vm/vmm/firecracker-client';

interface PageShape {
  readonly memoryMib: number;
  readonly maxMemoryMib: number;
}

// Firecracker refuses a 2 MiB guest whose memory is not a whole number of huge
// pages.
export function pickHugePages(isOn: boolean, imp: Readonly<PageShape>): HugePages {
  return isOn && imp.maxMemoryMib <= imp.memoryMib && imp.memoryMib % 2 === 0 ? '2M' : 'None';
}
