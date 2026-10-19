import { parseZfsRelease } from './zfs-commands';
import type { ZfsCommands } from './zfs-commands';

// what the ZFS backend lends its start's version check: its commands, the
// module version, its log, the operator's override and its /health warnings
interface ZfsVersionContext {
  readonly zfs: ZfsCommands;
  readonly readModuleVersion: () => string | null;
  readonly log: (message: string) => void;
  readonly isUiomoveBugAllowed: boolean | undefined;
  readonly host: { warnings: string[] };
}

// The userland and the kernel module must share a major version, and the
// module must not have the zfs_uiomove bug unless the operator allows it.
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

  // every command impd runs exists in 2.2 and later
  // (docs/architecture/storage/storage.md#zfs), so a minor skew only warns
  if (userRelease.minor !== kernelRelease.minor) {
    ctx.log(`impd: zfs: warning: the userland is ${userland} but the kernel module is ${kernel}`);
  }

  // the oops this bug causes holds a disk until a reboot, so a host needs
  // the fix (docs/architecture/host.md); the override only warns
  if (hasUiomoveBug(kernel) && ctx.isUiomoveBugAllowed !== true) {
    throw new Error(
      `zfs: ${formatUiomoveWarning(kernel)}; upgrade the module, or set ` +
        'IMP_ZFS_ALLOW_UIOMOVE_BUG=1 to start anyway',
    );
  }

  ctx.host.warnings = hasUiomoveBug(kernel) ? [formatUiomoveWarning(kernel)] : [];

  for (const warning of ctx.host.warnings) {
    ctx.log(`impd: zfs: warning: ${warning}`);
  }
}

// The patch release of each minor line that first fixes zfs_uiomove's short
// copy (openzfs/zfs#15918, fixed by openzfs/zfs#18408). A line before 2.3 has
// no fix, and one after 2.4 starts with it.
const UIOMOVE_FIXED_PATCHES = new Map([
  [3, 7],
  [4, 2],
]);

// Whether this module overruns a buffer when a kill lands during
// Firecracker's read() of a disk, which oopses a hardened-usercopy kernel
// (docs/architecture/storage/storage.md#zfs). An unread version passes.
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
