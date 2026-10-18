import type { ColdBootCause } from '@impz/api';
import { ORPCError } from '@orpc/server';
import { isAgentError } from '../agent-client/is-agent-error';
import { buildAgentOutdatedApiError, buildStoppingError } from '../api-errors';
import { removeNextBootCause, writeColdBoot } from '../db/cold-boots';
import { removeIdentityReset, updateImpActivity, updateImpDisk } from '../db/imps';
import type { ImpStateChange } from '../db/update-imp-state';
import { createSemaphore } from '../process/semaphore';
import { readErrorMessage } from '../read-error-message';
import { findSessionLogImp } from '../session-logs/find-session-log-imp';
import { removeSnapshot } from '../sleep/snapshot-meta';
import { writeVmIdentity } from '../sleep/vm-identity';
import type { VmIdentity } from '../sleep/vm-identity';
import type { ImpPaths } from '../storage/data-layout';
import type { ImpCgroup } from '../vmm/cpu-cgroups';
import { checkMergeFlag } from './check-merge-flag';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';
import { makeSleepImpVm } from './make-sleep-imp-vm';
import type { YoungGuestWait } from './make-sleep-imp-vm';
import { makeWakeImpVm } from './make-wake-imp-vm';
import { startCounting } from './read-running-imp-usage';
import { requireNoOopsHold } from './require-no-oops-hold';
import { startColdVm } from './start-cold-vm';
import { updateLockedImpState } from './update-locked-imp-state';

// snapshot writes put the whole mem file through the page cache
// (docs/architecture/lifecycle/sleep-and-wake.md#sleep): a few at a time
const SLEEP_CONCURRENCY = 2;

// why a jailed VM does not start without its cgroup: cgroup.kill is what
// stops every process a guest escape forks, faster than any /proc scan
const NO_JAIL_CGROUP =
  'a jailed VM starts only in its own cgroup, and it has none: the cpu controller is not delegated to /sys/fs/cgroup/imps, or the setup of imps/<id> failed (see the log); set IMP_JAILER=false on a host without cgroup delegation';

// The VM side of the lifecycle. Every operation takes a LockedImp: the caller
// holds the imp's lock, and the record it passes is fresh.
export interface ImpVmOps {
  // moves the record to another state, checked against the lifecycle
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;

  // the full text goes to the log, its first line to the record
  readonly writeFailure: (imp: LockedImp, error: unknown) => Promise<void>;

  // boots the imp's disk; a memory snapshot is dropped first. `cause` is
  // what the boot records (docs/architecture/guest/sessions.md#generations-boots-and-offsets).
  readonly startImpVm: (
    imp: LockedImp,
    cause: Extract<ColdBootCause, 'start' | 'restore'>,
  ) => Promise<LockedImp>;

  // a new imp's first boot while its disk is still being sized: a template
  // restore runs up to the parked guest meanwhile
  readonly startNewImpVm: (imp: LockedImp, diskReady: Promise<unknown>) => Promise<LockedImp>;

  // agent shutdown, then the memory goes too: a stopped imp boots cold. Not
  // `graceful`, it kills Firecracker at once: for a guest whose disk and
  // memory are thrown away next.
  readonly stopImpVm: (imp: LockedImp, graceful?: boolean) => Promise<LockedImp>;

  // snapshots the VM and stops it (docs/architecture/lifecycle/sleep-and-wake.md#sleep);
  // a failed snapshot leaves it running, a failure after the kill stops the
  // imp. A sleep that gives way to a busy imp returns it still running.
  readonly sleepImpVm: (
    imp: LockedImp,
    reason: string,
    youngGuest?: YoungGuestWait,
  ) => Promise<LockedImp>;

  // the running imp, woken or booted first
  readonly requireRunningImp: (imp: LockedImp) => Promise<LockedImp>;

  // a running guest grows its filesystem into a grown disk file; a failure
  // leaves the grow pending for the next wake, and a cold boot grows anyway
  readonly growGuestDisk: (imp: LockedImp) => Promise<LockedImp>;

  // kills the VM without asking its agent, which may not answer, and boots
  // the disk cold, the watchdog's restart; `reason` says why on the imp
  readonly startFreshImpVm: (imp: LockedImp, reason: string) => Promise<LockedImp>;

  // runs a snapshot write in one of the host-wide sleep slots
  readonly withSleepSlot: <T>(task: () => Promise<T>) => Promise<T>;

  // once impd puts every imp to sleep to stop: no VM starts after that,
  // since it would outlive impd's last sleep pass; a start throws
  // SERVICE_UNAVAILABLE
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

    // the VM is gone, and the generations its sessions ran with it
    if (change.state === 'stopped' || change.state === 'error') {
      void context.sessionLogs.endImp(findSessionLogImp(context.findPaths, updated));
    }

    return updated;
  };

  const writeFailure = async (imp: LockedImp, error: unknown): Promise<void> => {
    const message = readErrorMessage(error);

    context.log(`impd: ${imp.name}: ${message}`);

    await updateState(imp, {
      reason: 'failed',
      state: 'error',
      pid: null,
      error: message.split('\n')[0] ?? '',
    });
  };

  // The identity is advisory: a VM without one sleeps into a snapshot that
  // boots cold, so a failed write (a full disk) must not fail the boot.
  const writeIdentity = (imp: LockedImp, paths: ImpPaths, identity: VmIdentity): void => {
    try {
      writeVmIdentity(paths, identity);
    } catch (error) {
      context.log(`impd: ${imp.name}: could not write vm.json: ${readErrorMessage(error)}`);
    }
  };

  // the cgroup a VM starts in; a jailed VM refuses to start without one
  const setupVmCgroup = (imp: LockedImp): ImpCgroup | null => {
    const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

    if (cgroup === null && context.findJailUser(imp) !== null) {
      throw new Error(NO_JAIL_CGROUP);
    }

    return cgroup;
  };

  // `reason` says why a wake booted cold instead; null for a create or a start
  // `cause` is the typed reason the boot records; a wake_fallback counts as
  // the wake it stands in for
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
      // a create cut short by impd stopping shows why; any other imp keeps
      // the state it had
      if (imp.state === 'creating') {
        await writeFailure(imp, error);
      }

      throw error;
    }

    const paths = context.findPaths(imp.id);
    const address = context.findAddress(imp.slot);
    const admitStarted = performance.now();

    // a fresh guest's RSS starts small and grows; reserve part of its memory
    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.ceil((imp.memoryMib * context.config.bootReservePercent) / 100),
      memoryMib: imp.maxMemoryMib,
    });

    const setupStarted = performance.now();

    try {
      // a memory snapshot is only valid with the disk it was taken with. It
      // goes once the boot is admitted: a sleeping imp the budget turns away
      // keeps its memory.
      removeSnapshot(paths);

      // a box or none imp never runs where nft cannot hold it in
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(address, context.findJailUser(imp));

      // the host's part before the VM, for the boot's log line
      const hostSteps = {
        admit: Math.round(setupStarted - admitStarted),
        setup: Math.round(performance.now() - setupStarted),
      };

      // a fresh guest holds nothing plugged; the cgroup keeps a size from
      // before a sleep, which a wake that boots cold must not inherit
      context.memoryLimit.setGuestMib(imp.id, imp.memoryMib);

      const cgroup = setupVmCgroup(imp);

      const vm = await startColdVm(context, { imp, paths, address, cgroup, hostSteps, diskReady });

      startCounting(context, imp, vm.pid);

      await checkMergeFlag(context, imp, vm.pid);

      // its sleeps record this, whatever the host boots by then
      writeIdentity(imp, paths, {
        ...context.identity,
        agentVersion: vm.agentVersion,
        bootReason: reason,
      });

      await updateImpActivity(context.db, imp.id, new Date());

      // an agent from before output offsets has no boot_id; its sessions
      // have no generations for a boot to end
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

      // the flag stays until a boot reports the reset done, so a failed
      // ssh-keygen is tried again on the next boot
      const reset =
        running.isIdentityResetPending && vm.identityReset === 'ok'
          ? await removeLockedIdentityReset(running)
          : running;

      if (reset.isIdentityResetPending) {
        context.log(
          `impd: ${imp.name}: the identity reset did not finish (${vm.identityReset ?? 'no report'}); the next boot tries again`,
        );
      }

      // the agent grew the filesystem to fill the disk
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
      const message = readErrorMessage(error);

      context.log(`impd: ${imp.name}: the guest did not grow into its disk: ${message}`);

      await setGrowPending(imp, true);

      if (isAgentError(error, 'AGENT_OUTDATED')) {
        throw buildAgentOutdatedApiError(
          "the disk grew, but the imp's agent is too old to grow its filesystem while it runs; its next boot does (stop and start the imp)",
        );
      }

      throw new ORPCError('INTERNAL_SERVER_ERROR', {
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

    // a wake goes through below the reserve, so a full disk never strands an
    // imp's work; a cold boot writes the disk from the start, and waits
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
  return Object.values(timings).reduce((total, ms) => total + ms, 0);
}
