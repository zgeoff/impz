import type { HugePages } from '../../vm/vmm/firecracker-client';

// A 2 MiB snapshot restores only through a page handler. With huge pages off,
// the host may have no pool left, so the guest wakes on the host's pages.
export function pickWakeHugePages(
  recorded: HugePages | undefined,
  isOn: boolean,
): HugePages | null {
  if (recorded !== '2M') {
    return null;
  }

  return isOn ? '2M' : 'None';
}
