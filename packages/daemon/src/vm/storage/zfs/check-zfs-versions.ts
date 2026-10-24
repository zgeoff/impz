import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { parseZfsRelease } from './zfs-commands';
import type { ZfsCommands } from './zfs-commands';

interface ZfsVersionContext {
  readonly zfs: ZfsCommands;
  readonly readModuleVersion: () => string | null;
  readonly isUiomoveBugAllowed: boolean | undefined;
  readonly host: { warnings: string[] };
}

export async function checkZfsVersions(ctx: ZfsVersionContext): Promise<void> {
  const kernel = ctx.readModuleVersion();

  if (kernel === null) {
    throw new Error('zfs: the kernel module is not loaded (no /sys/module/zfs/version)');
  }

  const userland = await ctx.zfs.readVersion();

  const userRelease = parseZfsRelease(userland);
  const kernelRelease = parseZfsRelease(kernel);

  if (userRelease.major !== kernelRelease.major) {
    throw new Error(
      `zfs: the userland is ${userland} but the kernel module is ${kernel}; they must match in major version`,
    );
  }

  // Every zfs command impd runs exists in ZFS 2.2 and later, so a minor skew only warns.
  if (userRelease.minor !== kernelRelease.minor) {
    getImpdLogger('zfs').warning('the userland is {userland} but the kernel module is {kernel}', {
      userland,
      kernel,
    });
  }

  // The kernel oops this bug causes holds a disk until a reboot, so a host needs the fixed module.
  if (hasUiomoveBug(kernel) && ctx.isUiomoveBugAllowed !== true) {
    throw new Error(
      `zfs: ${formatUiomoveWarning(kernel)}; upgrade the module, or set ` +
        'IMP_ZFS_ALLOW_UIOMOVE_BUG=1 to start anyway',
    );
  }

  ctx.host.warnings = hasUiomoveBug(kernel) ? [formatUiomoveWarning(kernel)] : [];

  for (const warning of ctx.host.warnings) {
    getImpdLogger('zfs').warning('{warning}', { warning });
  }
}

// openzfs/zfs#18408 fixes the zfs_uiomove short copy (openzfs/zfs#15918) in these patch releases.
// A minor line before 2.3 has no fix, and one after 2.4 starts with it.
const UIOMOVE_FIXED_PATCHES = new Map([
  [3, 7],
  [4, 2],
]);

// A module with the bug overruns a buffer when a kill lands during Firecracker's read() of a disk,
// which oopses a kernel with hardened usercopy.
function hasUiomoveBug(version: string): boolean {
  const found = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/v.exec(version)?.groups;

  if (found === undefined) {
    return false;
  }

  const major = Number(found['major']);
  const minor = Number(found['minor']);

  if (major !== 2) {
    return major < 2;
  }

  if (minor < 3) {
    return true;
  }

  const fixedPatch = UIOMOVE_FIXED_PATCHES.get(minor);

  return fixedPatch !== undefined && Number(found['patch']) < fixedPatch;
}

function formatUiomoveWarning(version: string): string {
  return (
    `the zfs kernel module ${version} has the zfs_uiomove short-copy bug (openzfs/zfs#15918): ` +
    'a VM killed during a disk read can oops the kernel and hold its disk until a reboot; ' +
    'modules 2.3.7, 2.4.2 and later fix it'
  );
}
