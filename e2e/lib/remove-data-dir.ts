import { LIB_SCRIPT, readHostImageFromEnv, runChecked } from './instance';
import { runHostZfs } from './run-host-zfs';
import type { WipeTarget } from './wipe-target';
import { ZFS_OWNER_FILE, resetZfsRoot } from './zfs-owner';

export async function removeDataDir(target: Readonly<WipeTarget>): Promise<void> {
  const hostImage = readHostImageFromEnv();

  await runChecked(['bash', '-c', 'source "$1" && ensure_host_image', 'bash', LIB_SCRIPT]);

  // imp.xfs is root-owned, and a stale loop device can outlive the container.
  await runChecked([
    'docker',
    'run',
    '--rm',
    '--privileged',
    '-v',
    `${target.directory}:/d`,
    hostImage,
    'bash',
    '-c',
    `for dev in $(losetup -n -O NAME -j /d/imp.xfs 2>/dev/null); do losetup -d "$dev" || true; done; find /d -mindepth 1 ! -path /d/${ZFS_OWNER_FILE} -delete`,
  ]);

  if (target.zfs !== null) {
    await resetZfsRoot(target.zfs, runHostZfs);
  }
}
