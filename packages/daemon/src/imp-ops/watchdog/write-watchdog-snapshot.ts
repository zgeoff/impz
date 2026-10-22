import { chmodSync, lchownSync, mkdirSync, rmSync } from 'node:fs';
import type { ImpDisk, ImpHost, ImpVms } from '../../imps/imps/imp-context';
import type { LockedImp } from '../../imps/imps/imp-lock';
import type { ImpVmOps } from '../../imps/imps/imp-vm-ops';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { IMPD_USER } from '../../platform/process/impd-user';
import { buildSnapshotIdentity, writeSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import { buildWatchdogSlot } from '../../vm/storage/data-layout';
import { isDiskFullError } from '../../vm/storage/disk-full-error';

export async function writeWatchdogSnapshot(
  context: ImpHost & ImpVms & ImpDisk,
  ops: Pick<ImpVmOps, 'withSleepSlot'>,
  imp: LockedImp,
): Promise<void> {
  const paths = context.findPaths(imp.id);
  const slot = buildWatchdogSlot(paths.directory);
  const pid = imp.pid;

  if (pid === null) {
    return;
  }

  rmSync(slot.snapshotDir, { recursive: true, force: true });

  const writeSlot = async () => {
    // A jailed VM opens the files impd makes here, so it must pass through.
    mkdirSync(slot.snapshotDir, { recursive: true, mode: 0o711 });

    const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

    await ops.withSleepSlot(() => context.vms.sleepVm(pid, paths, cgroup, slot));

    writeSnapshotMeta(slot, {
      ...buildSnapshotIdentity(readVmIdentity(paths), context.identity),
      createdAt: Date.now(),
      memoryMib: imp.memoryMib,
      ramMib: 0,
    });

    for (const file of [slot.vmstate, slot.memFile, slot.snapshotMeta]) {
      lchownSync(file, IMPD_USER.uid, IMPD_USER.gid);
      chmodSync(file, 0o600);
    }

    chmodSync(slot.snapshotDir, 0o700);
  };

  try {
    await context.diskBudget.withRoom(imp.memoryMib * 1024 * 1024, writeSlot);

    context.log(`impd: ${imp.name}: the watchdog kept its memory in ${slot.snapshotDir}`);
  } catch (error) {
    rmSync(slot.snapshotDir, { recursive: true, force: true });

    const what = isDiskFullError(error) ? 'no watchdog snapshot' : 'the watchdog snapshot failed';

    context.log(`impd: ${imp.name}: ${what}: ${getErrorMessage(error)}`);
  }
}
