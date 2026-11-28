import type { HugePages } from '../../vm/vmm/firecracker-client';

// A 2 MiB snapshot restores only through a page handler. With huge pages off,
// the host may have no pool left, so the guest wakes on the host's pages.
// A transparent snapshot restores from its memory file, which keeps no madvise hint.
export function pickWakeHugePages(
  recorded: HugePages | undefined,
  isOn: boolean,
): HugePages | null {
  if (recorded === 'Transparent') {
    return 'None';
  }

  if (recorded !== '2M') {
    return null;
  }

  return isOn ? '2M' : 'None';
}
