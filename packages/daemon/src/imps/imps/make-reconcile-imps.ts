import { writeUnknownBoot } from '../../platform/db/cold-boots';
import { listImps } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
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

  return async () => {
    const flag = context.kernelOops.readFlag();

    if (flag === 'set') {
      getImpdLogger('imps').info(
        'the kernel oopsed since the host booted (taint flag D); the host needs a reboot',
      );
    }

    if (flag === 'unknown') {
      getImpdLogger('imps').warning(
        'cannot read the kernel taint flag; imps a kernel oops held stay held',
      );
    }

    const imps = await listImps(context.db);

    const bootId = context.kernelOops.readCurrentBootId();

    await removeStaleOopsHolds(
      context,
      imps.filter(
        (imp) =>
          flag === 'clear' ||
          (bootId !== null && imp.oopsBootId !== null && imp.oopsBootId !== bootId),
      ),
    );

    const impIds = new Set(imps.map((imp) => imp.id));

    // The jail sweep kills every process of the uid, so the cgroups are empty
    // for their rmdir.
    for (const impId of await context.vms.removeOrphanJails(impIds)) {
      getImpdLogger('jail').info('removed the jail of imp {impId}: no imp has that id', { impId });
    }

    for (const impId of context.cgroups.removeOrphans(impIds)) {
      getImpdLogger('cgroup').info('removed the cgroup of imp {impId}: no imp has that id', {
        impId,
      });
    }

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

            // A loaded guest may answer late, and killing it would lose its memory.
            if (imp.state === 'running') {
              const ready = await context.vms.probeAgentReady(paths);

              const note = ready ? '' : ' (the agent does not answer yet)';
              const jailed = imp.pid !== null && probeJailedFirecracker(imp.pid) ? 'jailed ' : '';

              getImpdLogger('imps')
                .with({ imp: imp.name })
                .info('re-adopted {jailed}firecracker pid {pid}{note}', {
                  jailed,
                  pid: String(imp.pid),
                  note,
                });

              if (imp.pid !== null) {
                await setAdoptedMemoryLimit(imp, paths);

                context.cgroups.adopt(imp.id, imp.pid, imp.cpu, imp.memoryMib);

                startCounting(context, imp, imp.pid);

                await checkAdoptedMergeFlag(context, imp, imp.pid);
              }

              if (ready) {
                await writeAdoptedBoot(context, imp);
              }

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
              getImpdLogger('imps')
                .with({ imp: imp.name })
                .warning('could not stop: {error}', { error: getErrorMessage(stopError) });

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

async function removeStaleOopsHolds(context: ImpHost, imps: readonly ImpRecord[]): Promise<void> {
  for (const imp of imps.filter((listed) => listed.hasOopsHold)) {
    await updateImpState(context.db, imp.id, {
      reason: 'repaired',
      state: imp.state,
      error: null,
      hasOopsHold: false,
      oopsBootId: null,
    });

    getImpdLogger('imps')
      .with({ imp: imp.name })
      .info('the host rebooted since a kernel oops held its disk');
  }
}

async function writeAdoptedBoot(context: ImpHost & ImpVms, imp: ImpRecord): Promise<void> {
  try {
    const ping = await sendPing(context.findPaths(imp.id).vsockSocket);

    if (ping.bootId !== undefined) {
      await writeUnknownBoot(context.db, imp.id, ping.bootId, new Date());
    }
  } catch (error) {
    getImpdLogger('imps')
      .with({ imp: imp.name })
      .warning('could not read its boot id: {error}', { error: getErrorMessage(error) });
  }
}
