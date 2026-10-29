import type { ColdBootCause } from '@impz/api';
import { writeUnknownBoot } from '../../platform/db/cold-boots';
import { claimTrustPending, updateImpActivity } from '../../platform/db/imps';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { buildStoppingError } from '../../platform/errors/impd-errors';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import {
  readColdBootReason,
  readSnapshotMeta,
  removeSnapshot,
  removeSnapshotMeta,
  setSnapshotLoading,
} from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import type { VmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import type { ImpCgroup } from '../../vm/vmm/cpu-cgroups';
import type { HugePages } from '../../vm/vmm/firecracker-client';
import { checkMergeFlag } from './check-merge-flag';
import { formatTimings } from './format-timings';
import type { ImpContext } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { LockedImp } from './imp-lock';
import { OOM_KILL_TRIGGER, startOomWatch } from './oom-kill';
import { pickWakeHugePages } from './pick-wake-huge-pages';
import { startCounting } from './read-running-imp-usage';
import { requireNoOopsHold } from './require-no-oops-hold';

interface WakeDeps {
  readonly context: ImpContext;

  readonly isStopping: () => boolean;
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;
  readonly writeIdentity: (imp: LockedImp, paths: ImpPaths, identity: VmIdentity) => void;
  readonly setupVmCgroup: (imp: LockedImp) => ImpCgroup | null;
  readonly startColdImpVm: (
    imp: LockedImp,
    cause: Extract<ColdBootCause, 'wake_fallback'>,
    reason: string | null,
  ) => Promise<LockedImp>;
  readonly growGuestDisk: (imp: LockedImp) => Promise<LockedImp>;
}

export function makeWakeImpVm(deps: WakeDeps): (imp: LockedImp) => Promise<LockedImp> {
  const context = deps.context;
  const updateState = deps.updateState;
  const setupVmCgroup = deps.setupVmCgroup;
  const startColdImpVm = deps.startColdImpVm;
  const growGuestDisk = deps.growGuestDisk;

  const wakeImpVm = async (imp: LockedImp): Promise<LockedImp> => {
    if (deps.isStopping()) {
      throw buildStoppingError();
    }

    requireNoOopsHold(context, imp);

    const paths = context.findPaths(imp.id);
    const meta = readSnapshotMeta(paths);

    const mismatch =
      meta === null ? 'no snapshot it can load' : readColdBootReason(meta, context.identity);

    if (meta === null || mismatch !== null || meta.systemDrivePath === undefined) {
      getImpdLogger('imps')
        .with({ imp: imp.name })
        .info('cold boot instead of a wake: {mismatch}', {
          mismatch: mismatch ?? 'no snapshot it can load',
        });

      return startColdImpVm(imp, 'wake_fallback', mismatch);
    }

    const cgroup = setupVmCgroup(imp);
    const hugePages = pickWakeHugePages(meta.hugePages, context.config.hugePages !== null);

    await context.admission?.admit({
      id: imp.id,
      name: imp.name,
      reserveMib: Math.max(meta.ramMib, context.config.wakeReserveMib),
      memoryMib: imp.maxMemoryMib,
      hugePagesMib: hugePages === '2M' ? imp.memoryMib : 0,
    });

    // The load restores what the guest held plugged, so the host limit allows it first.
    context.memoryLimit.setGuestMib(imp.id, imp.memoryMib + (meta.pluggedMib ?? 0));

    if (meta.pluggedMib !== undefined) {
      context.pluggedSizes.write(imp.id, meta.pluggedMib);
    }

    const started = performance.now();

    setSnapshotLoading(paths);

    const woken = await loadSnapshot(imp, paths, cgroup, {
      systemDrivePath: meta.systemDrivePath,
      hugePages,
    });

    if (woken instanceof Error) {
      return startAfterFailedWake(imp, paths, woken);
    }

    // The snapshot reopens the drive the VM booted from, so its agent answers
    // with the version it had then, and any other version is another VM.
    if (meta.agentVersion !== undefined && woken.agentVersion !== meta.agentVersion) {
      await stopWrongVm(imp, paths, woken.pid);

      const wrong = new Error(
        `the agent answered as ${woken.agentVersion}, not ${meta.agentVersion}`,
      );

      return startAfterFailedWake(imp, paths, wrong);
    }

    const wakeMs = Math.round(performance.now() - started);

    getImpdLogger('imps')
      .with({ imp: imp.name })
      .info('woke pid {pid} in {wakeMs}ms {timings}', {
        pid: String(woken.pid),
        wakeMs: String(wakeMs),
        timings: formatTimings(woken.timings),
      });

    if (hugePages === 'None') {
      writeHostPagesIdentity(imp, paths);
    }

    startCounting(context, imp, woken.pid);

    await checkMergeFlag(context, imp, woken.pid);
    await updateImpActivity(context.db, imp.id, new Date());

    if (woken.bootId !== undefined) {
      await writeUnknownBoot(context.db, imp.id, woken.bootId, new Date());
    }

    const running = await updateState(imp, {
      reason: 'woke',
      detail: { durationMs: wakeMs, steps: woken.timings },
      state: 'running',
      pid: woken.pid,
      error: null,
      sleptAt: null,
      firecrackerVersion: woken.firecrackerVersion,
    });

    removeSnapshotMeta(paths);

    const trusted = running.isTrustPending ? await applyPendingTrust(running, paths) : running;

    if (!trusted.isDiskGrowPending) {
      return trusted;
    }

    return growGuestDisk(trusted).catch(() => trusted);
  };

  const applyPendingTrust = async (imp: LockedImp, paths: ImpPaths): Promise<LockedImp> => {
    try {
      if (!(await claimTrustPending(context.db, imp.id))) {
        return imp;
      }

      await context.readExecEnv(imp, paths.vsockSocket);
    } catch (error) {
      getImpdLogger('imps')
        .with({ imp: imp.name })
        .warning('broker CA after the wake: {error}', { error: getErrorMessage(error) });
    }

    return toLockedImp(imp, { ...imp, isTrustPending: false });
  };

  // the guest left its 2 MiB pages behind, and holds no pool pages from here on
  const writeHostPagesIdentity = (imp: LockedImp, paths: ImpPaths): void => {
    const booted = readVmIdentity(paths);

    if (booted !== null) {
      const { hugePages: _, ...onHostPages } = booted;

      deps.writeIdentity(imp, paths, onHostPages);
    }
  };

  const loadSnapshot = async (
    imp: LockedImp,
    paths: ImpPaths,
    cgroup: ImpCgroup | null,
    snapshot: Readonly<{ systemDrivePath: string; hugePages: HugePages | null }>,
  ) => {
    const hasOomKill = startOomWatch(context.cgroups, imp.id);

    try {
      // A container restart takes the taps with it.
      await context.egress.requireImp(imp.id);
      await context.taps.setupTap(context.findAddress(imp.slot), context.findJailUser(imp));

      return await context.vms.wakeVm({
        firecrackerBin: context.config.firecrackerBin,
        paths,
        cgroup,
        jail: context.findJailUser(imp),
        readOnlyFiles: [snapshot.systemDrivePath],
        ...(snapshot.hugePages !== null && { hugePages: snapshot.hugePages }),
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(getErrorMessage(error));

      return hasOomKill()
        ? new Error(`wake failed: ${OOM_KILL_TRIGGER}\n${failure.message}`, { cause: failure })
        : failure;
    }
  };

  // A VM that will not stop still has the disk open, and a cold boot now would
  // put two VMs on one disk.
  const stopWrongVm = async (imp: LockedImp, paths: ImpPaths, pid: number): Promise<void> => {
    try {
      await context.vms.stopVm(pid, paths, false);
    } catch (error) {
      const message = getErrorMessage(error);

      getImpdLogger('imps')
        .with({ imp: imp.name })
        .warning('could not stop the woken VM: {message}', { message });

      context.admission?.release(imp.id);
      removeSnapshot(paths);

      await updateState(imp, {
        reason: 'failed',
        state: 'error',
        pid,
        error: `could not stop: ${message}`,
      });

      throw error;
    }
  };

  const startAfterFailedWake = async (
    imp: LockedImp,
    paths: ImpPaths,
    error: Readonly<Error>,
  ): Promise<LockedImp> => {
    const failure = error.message.split('\n')[0] ?? '';

    getImpdLogger('imps').with({ imp: imp.name }).warning('{failure}; booting cold', { failure });
    context.admission?.release(imp.id);

    // The load may have run the guest, which can write its disk, so the
    // snapshot no longer matches it even if the cold boot is turned away.
    removeSnapshot(paths);

    const stopped = await updateState(imp, {
      reason: 'stopped',
      detail: { trigger: failure },
      state: 'stopped',
      pid: null,
    });

    return startColdImpVm(stopped, 'wake_fallback', failure);
  };

  return wakeImpVm;
}
