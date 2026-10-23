import type { ColdBootCause } from '@impz/api';
import { removeNextBootCause, writeColdBoot } from '../../platform/db/cold-boots';
import { requireTransition } from '../../platform/db/imp-transitions';
import { removeIdentityReset, updateImpActivity, updateImpDisk } from '../../platform/db/imps';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildAgentOutdatedApiError, buildStoppingError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { createSemaphore } from '../../platform/process/semaphore';
import { isAgentError } from '../../vm/agent-client/is-agent-error';
import { removeSnapshot } from '../../vm/sleep/snapshot-meta';
import { writeVmIdentity } from '../../vm/sleep/vm-identity';
import type { VmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import type { ImpCgroup } from '../../vm/vmm/cpu-cgroups';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import { checkMergeFlag } from './check-merge-flag';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { makeSleepImpVm } from './make-sleep-imp-vm';
import type { YoungGuestWait } from './make-sleep-imp-vm';
import { makeWakeImpVm } from './make-wake-imp-vm';
import { startCounting } from './read-running-imp-usage';
import { requireNoOopsHold } from './require-no-oops-hold';
import { startColdVm } from './start-cold-vm';
import { updateLockedImpState } from './update-locked-imp-state';

// Each snapshot write puts the whole memory file through the page cache, so
// only a few run at once.
const SLEEP_CONCURRENCY = 2;

// cgroup.kill stops every process a guest escape forks, faster than any /proc
// scan, so a jailed VM never starts without its cgroup.
const NO_JAIL_CGROUP =
  'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation';

export interface ImpVmOps {
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;

  readonly writeFailure: (imp: LockedImp, error: unknown) => Promise<void>;

  readonly startImpVm: (
    imp: LockedImp,
    cause: Extract<ColdBootCause, 'start' | 'restore'>,
  ) => Promise<LockedImp>;

  readonly startNewImpVm: (imp: LockedImp, diskReady: Promise<unknown>) => Promise<LockedImp>;

  readonly stopImpVm: (imp: LockedImp, graceful?: boolean) => Promise<LockedImp>;

  readonly sleepImpVm: (
    imp: LockedImp,
    reason: string,
    youngGuest?: YoungGuestWait,
  ) => Promise<LockedImp>;

  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;

  readonly growGuestDisk: (imp: LockedImp) => Promise<LockedImp>;

  readonly startFreshImpVm: (imp: LockedImp, reason: string) => Promise<LockedImp>;

  readonly withSleepSlot: <T>(task: () => Promise<T>) => Promise<T>;

  readonly stopVmStarts: () => void;
}

export function createImpVmOps(context: ImpContext): ImpVmOps {
  const sleepSlots = createSemaphore(SLEEP_CONCURRENCY);
  let isStopping = false;

  const updateState = async (
    imp: LockedImp,
    change: Readonly<ImpStateChange>,
  ): Promise<LockedImp> => {
    const updated = await updateLockedImpState(context.db, imp, change);

    if (change.state !== 'running') {
      context.sessions.forget(imp.id);
      context.inners.forget(imp.id);
    }

    if (change.state === 'stopped' || change.state === 'error') {
      void context.sessionLogs.endImp(findSessionLogImp(context.findPaths, updated));
    }

    return updated;
  };

  const writeFailure = async (imp: LockedImp, error: unknown): Promise<void> => {
    const message = getErrorMessage(error);

    context.log(`impd: ${imp.name}: ${message}`);

    await updateState(imp, {
      reason: 'failed',
      state: 'error',
      pid: null,
      error: message.split('\n')[0] ?? '',
    });
  };

  const writeIdentity = (imp: LockedImp, paths: ImpPaths, identity: VmIdentity): void => {
    try {
      writeVmIdentity(paths, identity);
    } catch (error) {
      context.log(`impd: ${imp.name}: could not write vm.json: ${getErrorMessage(error)}`);
    }
  };

  const setupVmCgroup = (imp: LockedImp): ImpCgroup | null => {
    const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

    if (cgroup === null && context.findJailUser(imp) !== null) {
      throw new Error(NO_JAIL_CGROUP);
    }

    return cgroup;
  };

  const startColdImpVm = async (
    imp: LockedImp,
    cause: Exclude<ColdBootCause, 'recovery' | 'unknown'>,
    reason: string | null,
    diskReady: Promise<unknown> = Promise.resolve(),
  ): Promise<LockedImp> => {
    const isWake = cause === 'wake_fallback';

    try {
      if (isStopping) {
        throw buildStoppingError();
      }

      requireNoOopsHold(context, imp);
    } catch (error) {
      if (imp.state === 'creating') {
        await writeFailure(imp, error);
      }

      throw error;
    }

    const paths = context.findPaths(imp.id);
    const address = context.findAddress(imp.slot);
    const admitStarted = performance.now();

    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.ceil((imp.memoryMib * context.config.bootReservePercent) / 100),
      memoryMib: imp.maxMemoryMib,
    });

    const setupStarted = performance.now();

    try {
      // A memory snapshot loads only with the disk it was taken with. It goes
      // after admission, so a sleeping imp the budget turns away keeps it.
      removeSnapshot(paths);

      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(address, context.findJailUser(imp));

      const hostSteps = {
        admit: Math.round(setupStarted - admitStarted),
        setup: Math.round(performance.now() - setupStarted),
      };

      // The cgroup keeps a plugged size from before a sleep, which a fresh
      // guest that holds nothing plugged must not inherit.
      context.memoryLimit.setGuestMib(imp.id, imp.memoryMib);

      const cgroup = setupVmCgroup(imp);

      const vm = await startColdVm(context, { imp, paths, address, cgroup, hostSteps, diskReady });

      startCounting(context, imp, vm.pid);

      await checkMergeFlag(context, imp, vm.pid);

      writeIdentity(imp, paths, {
        ...context.identity,
        agentVersion: vm.agentVersion,
        bootReason: reason,
      });

      await updateImpActivity(context.db, imp.id, new Date());

      await (vm.bootId === undefined
        ? removeNextBootCause(context.db, imp.id)
        : writeColdBoot(context.db, imp.id, { bootId: vm.bootId, cause, at: new Date() }));

      const running = await updateState(imp, {
        reason: 'booted',
        detail: {
          durationMs: countStepsMs(vm.timings),
          steps: vm.timings,
          ...(reason !== null && { coldBootReason: reason }),
        },
        ...(isWake && { countsWake: true }),
        state: 'running',
        pid: vm.pid,
        error: null,
        sleptAt: null,
        firecrackerVersion: vm.firecrackerVersion,
      });

      const reset =
        running.isIdentityResetPending && vm.identityReset === 'ok'
          ? await removeLockedIdentityReset(running)
          : running;

      if (reset.isIdentityResetPending) {
        context.log(
          `impd: ${imp.name}: the identity reset did not finish (${vm.identityReset ?? 'no report'}); the next boot tries again`,
        );
      }

      return reset.isDiskGrowPending ? await setGrowPending(reset, false) : reset;
    } catch (error) {
      context.admission?.release(imp.id);

      await writeFailure(imp, error);

      throw error;
    }
  };

  const startImpVm: ImpVmOps['startImpVm'] = (imp, cause) => startColdImpVm(imp, cause, null);

  const startNewImpVm = (imp: LockedImp, diskReady: Promise<unknown>): Promise<LockedImp> =>
    startColdImpVm(imp, 'start', null, diskReady);

  const stopImpVm = async (imp: LockedImp, graceful = true): Promise<LockedImp> => {
    const paths = context.findPaths(imp.id);

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, paths, graceful);
    }

    await context.cgroups.remove(imp.id);

    removeSnapshot(paths);
    context.admission?.release(imp.id);

    return imp.state === 'stopped'
      ? imp
      : updateState(imp, { reason: 'stopped', state: 'stopped', pid: null });
  };

  const sleepImpVm = makeSleepImpVm({
    context,
    updateState,
    writeIdentity,
    withSleepSlot: sleepSlots.run,
  });

  const removeLockedIdentityReset = async (imp: LockedImp): Promise<LockedImp> => {
    const updated = await removeIdentityReset(context.db, imp.id);

    return toLockedImp(imp, updated);
  };

  const setGrowPending = async (imp: LockedImp, isGrowPending: boolean): Promise<LockedImp> => {
    const updated = await updateImpDisk(context.db, imp.id, {
      diskBytes: imp.diskBytes,
      isGrowPending,
    });

    return toLockedImp(imp, updated);
  };

  const growGuestDisk = async (imp: LockedImp): Promise<LockedImp> => {
    try {
      await context.vms.growDrive(context.findPaths(imp.id), imp.diskBytes);
    } catch (error) {
      const message = getErrorMessage(error);

      context.log(`impd: ${imp.name}: the guest did not grow into its disk: ${message}`);

      await setGrowPending(imp, true);

      if (isAgentError(error, 'AGENT_OUTDATED')) {
        throw buildAgentOutdatedApiError(
          "the disk grew, but the imp's agent is too old to grow its filesystem while it runs; its next boot does (stop and start the imp)",
        );
      }

      throw new ImpdError('INTERNAL_SERVER_ERROR', {
        message: `the disk grew, but the guest did not grow its filesystem (its next wake or boot does): ${message}`,
        cause: error,
      });
    }

    return imp.isDiskGrowPending ? setGrowPending(imp, false) : imp;
  };

  const wakeImpVm = makeWakeImpVm({
    context,
    isStopping: () => isStopping,
    updateState,
    setupVmCgroup,
    startColdImpVm,
    growGuestDisk,
  });

  const requireRunningImp = async (imp: LockedImp): Promise<LockedImp> => {
    if (imp.state === 'running') {
      return imp;
    }

    if (imp.state === 'sleeping') {
      return wakeImpVm(imp);
    }

    await context.diskBudget.requireRoom(0);

    requireTransition(imp.state, 'running', 'start');

    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, context.findPaths(imp.id), false);
    }

    return startImpVm(imp, 'start');
  };

  const startFreshImpVm = async (imp: LockedImp, reason: string): Promise<LockedImp> => {
    if (imp.pid !== null) {
      await context.vms.stopVm(imp.pid, context.findPaths(imp.id), false);
    }

    context.admission?.release(imp.id);

    const stopped = await updateState(imp, {
      reason: 'stopped',
      detail: { trigger: reason },
      state: 'stopped',
      pid: null,
    });

    return startColdImpVm(stopped, 'watchdog', reason);
  };

  return {
    updateState,
    writeFailure,
    startImpVm,
    startNewImpVm,
    stopImpVm,
    sleepImpVm,
    requireRunningImp,
    growGuestDisk,
    startFreshImpVm,
    withSleepSlot: sleepSlots.run,
    stopVmStarts: () => {
      isStopping = true;
    },
  };
}

function countStepsMs(timings: Readonly<Record<string, number>>): number {
  return Object.values(timings).reduce((total, durationMs) => total + durationMs, 0);
}
