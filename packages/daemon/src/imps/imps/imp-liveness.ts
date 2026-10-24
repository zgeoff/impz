import { readImpById } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { probeSnapshot, readLoadingMeta, readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { isImpVm } from '../../vm/vmm/firecracker-process';
import type { ImpHost, ImpMemory, ImpVms } from './imp-context';
import { KERNEL_OOPS_TRIGGER } from './kernel-oops-watch';
import { OOM_KILL_TRIGGER } from './oom-kill';

export async function checkLiveness(
  context: ImpHost & ImpVms & ImpMemory,
  imp: ImpRecord,
  canRepair: boolean,
): Promise<ImpRecord> {
  const paths = context.findPaths(imp.id);

  const lostSnapshot =
    imp.state === 'sleeping' && !probeSnapshot(paths) && readLoadingMeta(paths) === null;

  // A recycled pid whose argv a jail forged is alive, but it is not this imp's VM.
  const lostVm =
    imp.state === 'running' &&
    (imp.pid === null ||
      !context.vms.probeVmAlive(imp.pid, paths) ||
      !isImpVm(context.vms.readVmOwner(imp.pid), imp.id, imp.jailUid));

  if ((!lostSnapshot && !lostVm) || !canRepair) {
    return imp;
  }

  const trigger = lostVm ? readLostVmTrigger(context, imp) : null;
  const slept = lostVm ? readSleptChange(imp, paths) : null;

  const oopsBootId =
    trigger === KERNEL_OOPS_TRIGGER ? context.kernelOops.readCurrentBootId() : null;

  const change =
    slept !== null && trigger === KERNEL_OOPS_TRIGGER
      ? { ...slept, detail: { trigger }, error: trigger, hasOopsHold: true, oopsBootId }
      : slept;

  const repaired = await updateImpState(
    context.db,
    imp.id,
    change ?? {
      reason: 'repaired',
      state: 'stopped',
      pid: null,
      awakeUntil: readLastSeenAlive(context, imp),

      nextBootCause: lostVm ? 'recovery' : 'wake_fallback',
      ...(trigger !== null && {
        detail: { trigger },
        error: trigger,
        hasOopsHold: trigger === KERNEL_OOPS_TRIGGER,
        oopsBootId,
      }),
    },
    { state: imp.state, pid: imp.pid },
  );

  if (repaired === undefined) {
    const current = await readImpById(context.db, imp.id);

    return current ?? imp;
  }

  const what = lostSnapshot ? 'the snapshot is gone' : (trigger ?? 'firecracker is gone');

  const hold =
    trigger === KERNEL_OOPS_TRIGGER ? '; it stays off its disk until the host reboots' : '';

  getImpdLogger('imps')
    .with({ imp: imp.name })
    .info('{what}; marked it {state}{hold}', { what, state: repaired.state, hold });

  if (lostVm) {
    await context.vms.releaseVm(paths);
  }

  if (repaired.state === 'stopped') {
    await context.cgroups.remove(imp.id);
  }

  return repaired;
}

function readLostVmTrigger(context: ImpVms & ImpMemory, imp: Readonly<ImpRecord>): string | null {
  if (context.cgroups.probeOomKillSinceStart(imp.id)) {
    return OOM_KILL_TRIGGER;
  }

  const oopsSeenAt = context.kernelOops.readOopsSeenAt();
  const ranSince = imp.awakeSince?.getTime() ?? 0;

  if (oopsSeenAt === null || ranSince > oopsSeenAt) {
    return null;
  }

  const owners = context.kernelOops.readOopsOwners(context.resources.listThreadOwners);

  return owners === null || owners.has(imp.id) ? KERNEL_OOPS_TRIGGER : null;
}

function readSleptChange(imp: ImpRecord, paths: ImpPaths): ImpStateChange | null {
  const meta = readSnapshotMeta(paths);

  if (meta === null || meta.createdAt <= imp.lastActiveAt.getTime()) {
    return null;
  }

  const sleptAt = new Date(meta.createdAt);

  return { reason: 'repaired', state: 'sleeping', pid: null, sleptAt, awakeUntil: sleptAt };
}

function readLastSeenAlive(context: ImpMemory, imp: Readonly<ImpRecord>): Date {
  const sampled = context.resources.readLastSeenAt(imp.id)?.getTime() ?? 0;

  return new Date(Math.max(sampled, imp.lastActiveAt.getTime()));
}
