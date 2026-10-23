import { statSync } from 'node:fs';
import type { ImpEventDetail } from '@impz/api';
import { requireTransition } from '../../platform/db/imp-transitions';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { getErrorMessage } from '../../platform/process/get-error-message';
import { sendActivity } from '../../vm/agent-client/agent-requests';
import { toSeenSessions } from '../../vm/agent-client/seen-session';
import type { SeenSession } from '../../vm/agent-client/seen-session';
import { sendServicesList } from '../../vm/agent-client/service-requests';
import { shrinkGuest } from '../../vm/memory/shrink-guest';
import { waitForGuestAge } from '../../vm/sleep/guest-age';
import {
  buildSnapshotIdentity,
  removeSnapshot,
  removeSnapshotMeta,
  writeSnapshotMeta,
} from '../../vm/sleep/snapshot-meta';
import { readVmIdentity } from '../../vm/sleep/vm-identity';
import type { VmIdentity } from '../../vm/sleep/vm-identity';
import type { ImpPaths } from '../../vm/storage/data-layout';
import { formatTimings } from './format-timings';
import type { ImpContext } from './imp-context';
import type { LockedImp } from './imp-lock';
import { OOM_KILL_TRIGGER, startOomWatch } from './oom-kill';

const SLEEP_SHRINK_LIMIT_MS = 2000;
const SERVICES_FOR_SLEEP_MS = 1000;

export type YoungGuestWait =
  | { readonly wait: false }
  | { readonly wait: true; readonly isWanted: () => Promise<boolean> };

const ALWAYS_WAIT: YoungGuestWait = {
  wait: true,
  isWanted: () => Promise.resolve(true),
};

interface SleepDeps {
  readonly context: ImpContext;
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;
  readonly writeIdentity: (imp: LockedImp, paths: ImpPaths, identity: VmIdentity) => void;

  readonly withSleepSlot: <T>(task: () => Promise<T>) => Promise<T>;
}

interface SleepWithRoomOptions {
  readonly imp: LockedImp;
  readonly paths: ImpPaths;
  readonly pid: number;
  readonly reason: string;
  readonly waitedMs: number;
  readonly requestedAt: number;
}

export function makeSleepImpVm(
  deps: SleepDeps,
): (imp: LockedImp, reason: string, youngGuest?: YoungGuestWait) => Promise<LockedImp> {
  const context = deps.context;
  const updateState = deps.updateState;
  const writeIdentity = deps.writeIdentity;

  const readSessionsForSleep = async (imp: LockedImp, paths: ImpPaths) => {
    const seen = await sendActivity(paths.vsockSocket).then(
      (activity) => toSeenSessions(activity.sessions, new Date()),
      () => context.sessions.read(imp.id) ?? [],
    );

    return seen.map((session) => setDetached(session));
  };

  const shrinkForSleep = async (imp: LockedImp, paths: ImpPaths): Promise<number | null> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return null;
    }

    try {
      const shrunk = await shrinkGuest(context.vms, paths, {
        timeLimitMs: SLEEP_SHRINK_LIMIT_MS,
        now: context.now,
        sleep: context.sleep,
      });

      const pluggedMib = shrunk.pluggedMib;

      context.pluggedSizes.write(imp.id, pluggedMib);

      return pluggedMib;
    } catch (error) {
      context.log(`impd: ${imp.name}: no shrink before the sleep: ${getErrorMessage(error)}`);

      return readPluggedMib(imp, paths);
    }
  };

  const readPluggedMib = async (imp: LockedImp, paths: ImpPaths): Promise<number> => {
    if (imp.maxMemoryMib <= imp.memoryMib) {
      return 0;
    }

    try {
      const memory = await context.vms.readGuestMemory(paths);

      return Math.max(memory.pluggedMib, memory.requestedMib);
    } catch {
      return imp.maxMemoryMib - imp.memoryMib;
    }
  };

  const sleepWithRoom = async (options: SleepWithRoomOptions): Promise<LockedImp> => {
    const imp = options.imp;
    const paths = options.paths;
    const pid = options.pid;
    const reason = options.reason;
    const waitedMs = options.waitedMs;

    const pluggedMib = await shrinkForSleep(imp, paths);

    const ramMib = context.readSleepRamMib(pid, paths.apiSocket) ?? 0;

    const sessions = await readSessionsForSleep(imp, paths);

    const services = await sendServicesList(paths.vsockSocket, SERVICES_FOR_SLEEP_MS).catch(
      () => null,
    );

    const started = context.sleepTiming.now();
    const slept: { detail: ImpEventDetail } = { detail: { trigger: reason } };

    removeSnapshotMeta(paths);

    const hasOomKill = startOomWatch(context.cgroups, imp.id);

    try {
      const cgroup = context.cgroups.setup(imp.id, imp.cpu, imp.memoryMib);

      const timings = await deps.withSleepSlot(() =>
        context.vms.sleepVm(pid, paths, cgroup, paths),
      );

      const booted = readVmIdentity(paths);

      writeSnapshotMeta(paths, {
        ...buildSnapshotIdentity(booted, context.identity),
        createdAt: Date.now(),
        memoryMib: imp.memoryMib,
        ramMib,
        ...(pluggedMib !== null && pluggedMib > 0 && { pluggedMib }),
        sessions,
        ...(services !== null && { services }),
      });

      if (booted !== null && booted.bootReason !== null) {
        writeIdentity(imp, paths, { ...booted, bootReason: null });
      }

      const sleepMs = Math.round(context.sleepTiming.now() - started);
      const waited = waitedMs > 0 ? `, waited ${String(waitedMs)}ms for a young guest` : '';

      slept.detail = {
        trigger: reason,
        durationMs: sleepMs,
        prepareMs: Math.round(started - options.requestedAt),
        steps: timings,
      };

      const plugged = pluggedMib === null ? '' : `, ${String(pluggedMib)} MiB plugged`;

      context.log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason})${waited}, ram ${String(ramMib)} MiB${plugged}, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
      );
    } catch (error) {
      if (context.vms.probeVmAlive(pid, paths)) {
        throw error;
      }

      // A snapshot's page cache counts against the cgroup's memory limit.
      const isOomKill = hasOomKill();
      const message = getErrorMessage(error);
      const failure = isOomKill ? `${OOM_KILL_TRIGGER} (${message})` : message;

      context.log(`impd: ${imp.name}: sleep failed after firecracker stopped: ${failure}`);

      removeSnapshot(paths);
      context.admission?.release(imp.id);

      await updateState(imp, {
        reason: 'stopped',
        detail: { trigger: isOomKill ? OOM_KILL_TRIGGER : reason },
        state: 'stopped',
        pid: null,
        ...(isOomKill && { error: OOM_KILL_TRIGGER }),
      });

      throw isOomKill ? new Error(`sleep failed: ${OOM_KILL_TRIGGER}`, { cause: error }) : error;
    }

    context.admission?.release(imp.id);

    return updateState(imp, {
      reason: 'slept',
      detail: slept.detail,
      state: 'sleeping',
      pid: null,
      sleptAt: new Date(),
    });
  };

  const sleepImpVm = async (
    imp: LockedImp,
    reason: string,
    youngGuest: YoungGuestWait = ALWAYS_WAIT,
  ): Promise<LockedImp> => {
    requireTransition(imp.state, 'sleeping', 'sleep');

    const requestedAt = context.sleepTiming.now();
    const paths = context.findPaths(imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    // The memory file is written in full before its holes are dug, so no wait
    // or pause starts unless the disk has room for all of it.
    const memFileMib = imp.memoryMib + (await readPluggedMib(imp, paths));

    const slept = await context.diskBudget.withRoom(memFileMib * 1024 * 1024, async () => {
      const waitedMs = youngGuest.wait
        ? await waitForGuestAge({
            readUptimeMs: () => context.vms.readGuestUptimeMs(paths),
            minUptimeMs: context.config.sleepMinGuestUptimeMs,
            isWanted: youngGuest.isWanted,
            now: context.sleepTiming.now,
            sleep: context.sleepTiming.sleep,
          })
        : 0;

      if (waitedMs === null) {
        context.log(`impd: ${imp.name}: sleep (${reason}) gave way: the imp turned busy`);

        return imp;
      }

      return sleepWithRoom({ imp, paths, pid, reason, waitedMs, requestedAt });
    });

    return slept;
  };

  return sleepImpVm;
}

function setDetached(session: SeenSession): SeenSession {
  return { ...session, attached: false };
}

function readDiskMib(path: string): number {
  try {
    return Math.round((statSync(path).blocks * 512) / 1_048_576);
  } catch {
    return 0;
  }
}
