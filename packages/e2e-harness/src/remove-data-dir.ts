import { realpathSync } from 'node:fs';
import type { ContainerCLI } from '../../../scripts/lib/build-dev-layout.ts';
import { ensureHostImage } from '../../../scripts/lib/ensure-host-image.ts';
import { readDevCheckout } from '../../../scripts/lib/read-dev-checkout.ts';
import { readMachineID } from '../../../scripts/lib/read-machine-id.ts';
import { readTextOrNull } from '../../../scripts/lib/read-text-or-null.ts';
import type { HarnessEnv } from './config';
import { REPO_ROOT, readHostImageFromEnv, runChecked } from './instance';
import { runHostZfs } from './run-host-zfs';
import type { WipeTarget } from './wipe-target';
import { ZFS_OWNER_FILE, resetZfsRoot } from './zfs-owner';

export async function removeDataDir(
  target: Readonly<WipeTarget>,
  env: HarnessEnv,
  containerCLI: ContainerCLI,
): Promise<void> {
  const hostImage = readHostImageFromEnv(env);

  await ensureHostImage(
    readDevCheckout(realpathSync, env, REPO_ROOT),
    readMachineID(readTextOrNull, env).id,
    containerCLI,
  );

  // imp.xfs is root-owned, and a stale loop device can outlive the container.
  await runChecked([
    containerCLI,
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
    await resetZfsRoot(target.zfs, (argv) => runHostZfs(argv, env));
  }
}
