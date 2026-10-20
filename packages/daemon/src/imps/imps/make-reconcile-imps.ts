import { writeUnknownBoot } from '../../platform/db/cold-boots';
import { listImps } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { sendPing } from '../../vm/agent-client/agent-requests';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { probeJailedFirecracker } from '../../vm/vmm/firecracker-process';
import { checkAdoptedMergeFlag } from './check-merge-flag';
import type { ImpClock, ImpGuest, ImpHost, ImpMemory, ImpVms } from './imp-context';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpVmOps } from './imp-vm-ops';
import { startCounting } from './read-running-imp-usage';
import { createVmReconciler } from './reconcile-vms';

interface ReconcileParts {
  readonly context: ImpHost & ImpClock & ImpVms & ImpMemory & ImpGuest;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
}

export function makeReconcileImps(parts: ReconcileParts): () => Promise<void> {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const reconciler = createVmReconciler(context, ops);

  // An elastic guest may hold more than its memory, and a new impd's cgroup
  // writer knows nothing of it: the limit covers what the guest holds, or the
  // most it can, before a sleep or a snapshot sets up the cgroup again.
  const setAdoptedMemoryLimit = async (imp: LockedImp, paths: ImpPaths): Promise<void> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return;
    }

    const pluggedMib = await context.vms.readGuestMemory(paths).then(
      (memory) => Math.max(memory.pluggedMib, memory.requestedMib),
      () => imp.maxMemoryMib - imp.memoryMib,
    );

    context.memoryLimit.setGuestMib(imp.id, imp.memoryMib + pluggedMib);
  };

  // the lock's liveness check marks an imp whose VM died with impd stopped
  return async () => {
    // the first read sets what a lost VM's oops is judged against
    const flag = context.kernelOops.readFlag();

    if (flag === 'set') {
      context.log(
        'impd: the kernel oopsed since the host booted (taint flag D); the host needs a reboot',
      );
    }

    if (flag === 'unknown') {
      context.log('impd: cannot read the kernel taint flag; imps a kernel oops held stay held');
    }

    const imps = await listImps(context.db);

    // a reboot freed the disk of a hold impd finds with the flag clear, which
    // only a reboot clears, or with another boot's id, whatever the flag reads
    const bootId = context.kernelOops.readCurrentBootId();

    await removeStaleOopsHolds(
      context,
      imps.filter(
        (imp) =>
          flag === 'clear' ||
          (bootId !== null && imp.oopsBootId !== null && imp.oopsBootId !== bootId),
      ),
    );

    // cgroups of imps destroyed while impd was down, or whose remove failed
    const impIds = new Set(imps.map((imp) => imp.id));

    // the jails first: their sweep kills every process of the uid, a
    // template build's too, so the cgroups are empty for the rmdir
    for (const impId of await context.vms.removeOrphanJails(impIds)) {
      context.log(`impd: removed the jail of imp ${impId}: no imp has that id`);
    }

    for (const impId of context.cgroups.removeOrphans(impIds)) {
      context.log(`impd: removed the cgroup of imp ${impId}: no imp has that id`);
    }

    // a moving imp too, as its move would: the moves recover after this
    await Promise.all(
      imps.map((listed) =>
        lock.withImpId(
          listed.id,
          async (found) => {
            if (found === undefined) {
              return;
            }

            const imp = await reconciler.reconcileImp(found);

            const paths = context.findPaths(imp.id);

            // a loaded guest may answer late; killing it would lose its memory
            if (imp.state === 'running') {
              const ready = await context.vms.probeAgentReady(paths);

              const note = ready ? '' : ' (the agent does not answer yet)';
              const jailed = imp.pid !== null && probeJailedFirecracker(imp.pid) ? 'jailed ' : '';

              context.log(
                `impd: ${imp.name}: re-adopted ${jailed}firecracker pid ${String(imp.pid)}${note}`,
              );

              if (imp.pid !== null) {
                await setAdoptedMemoryLimit(imp, paths);

                context.cgroups.adopt(imp.id, imp.pid, imp.cpu, imp.memoryMib);

                startCounting(context, imp, imp.pid);

                await checkAdoptedMergeFlag(context, imp, imp.pid);
              }

              if (ready) {
                await writeAdoptedBoot(context, imp);
              }

              // the record does not change; the event stream still hears of it
              await ops.updateState(imp, { reason: 'adopted', state: 'running' });

              return;
            }

            if (imp.state !== 'creating') {
              return;
            }

            const error = 'impd stopped while the imp was being created';

            try {
              if (imp.pid !== null && context.vms.probeVmAlive(imp.pid, paths)) {
                await context.vms.stopVm(imp.pid, paths, false);
              }
            } catch (stopError) {
              // one stuck VM must not keep impd from starting; the record
              // keeps its pid, so a start or destroy kills it again
              context.log(`impd: ${imp.name}: could not stop: ${getErrorMessage(stopError)}`);

              await ops.updateState(imp, { reason: 'failed', state: 'error', error });

              return;
            }

            await ops.updateState(imp, { reason: 'failed', state: 'error', pid: null, error });
          },
          { isMove: true },
        ),
      ),
    );

    await reconciler.killUnknownVms(new Set(imps.map((imp) => imp.id)));
  };
}

// Clears the hold an oops of an earlier boot left on an imp, so a new oops
// in another task never holds it again; the imp keeps its state.
async function removeStaleOopsHolds(context: ImpHost, imps: readonly ImpRecord[]): Promise<void> {
  for (const imp of imps.filter((listed) => listed.hasOopsHold)) {
    await updateImpState(context.db, imp.id, {
      reason: 'repaired',
      state: imp.state,
      error: null,
      hasOopsHold: false,
      oopsBootId: null,
    });

    context.log(`impd: ${imp.name}: the host rebooted since a kernel oops held its disk`);
  }
}

// A VM booted before impd kept cold boots has none on record: its boot is
// `unknown`, so a client still learns that it ended earlier generations.
async function writeAdoptedBoot(context: ImpHost & ImpVms, imp: ImpRecord): Promise<void> {
  try {
    const ping = await sendPing(context.findPaths(imp.id).vsockSocket);

    if (ping.bootId !== undefined) {
      await writeUnknownBoot(context.db, imp.id, ping.bootId, new Date());
    }
  } catch (error) {
    context.log(`impd: ${imp.name}: could not read its boot id: ${getErrorMessage(error)}`);
  }
}
