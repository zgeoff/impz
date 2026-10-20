import { statSync } from 'node:fs';
import type { ImpEventDetail } from '@impz/api';
import type { ImpStateChange } from '../../platform/db/update-imp-state';
import { readErrorMessage } from '../../platform/process/read-error-message';
import { sendActivity } from '../../vm/agent-client/agent-requests';
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
import { toSeenSessions } from '../sessions/session-cache';
import type { SeenSession } from '../sessions/session-cache';
import { formatTimings } from './format-timings';
import type { ImpContext } from './imp-context';
import type { LockedImp } from './imp-lock';
import { requireTransition } from './imp-transitions';
import { OOM_KILL_TRIGGER, startOomWatch } from './oom-kill';

// what a sleep waits under the imp's lock for an elastic guest to unplug
const SLEEP_SHRINK_LIMIT_MS = 2000;

// how long a sleep waits for the services list it records
const SERVICES_FOR_SLEEP_MS = 1000;

// How a sleep treats a guest younger than IMP_SLEEP_MIN_GUEST_UPTIME_MS: wait
// for it, and give way once `isWanted` turns false, or sleep it at once.
export type YoungGuestWait =
  | { readonly wait: false }
  | { readonly wait: true; readonly isWanted: () => Promise<boolean> };

const ALWAYS_WAIT: YoungGuestWait = {
  wait: true,
  isWanted: () => Promise.resolve(true),
};

// what a sleep needs of the rest of the VM operations
interface SleepDeps {
  readonly context: ImpContext;
  readonly updateState: (imp: LockedImp, change: Readonly<ImpStateChange>) => Promise<LockedImp>;
  readonly writeIdentity: (imp: LockedImp, paths: ImpPaths, identity: VmIdentity) => void;

  // runs a snapshot write in one of the host-wide sleep slots
  readonly withSleepSlot: <T>(task: () => Promise<T>) => Promise<T>;
}

// the sleepImpVm of ImpVmOps
export function makeSleepImpVm(
  deps: SleepDeps,
): (imp: LockedImp, reason: string, youngGuest?: YoungGuestWait) => Promise<LockedImp> {
  const context = deps.context;
  const updateState = deps.updateState;
  const writeIdentity = deps.writeIdentity;

  // the last look before the pause, under the imp's lock; nothing attaches
  // in between, since an open exec or attach keeps an imp from sleeping
  const readSessionsForSleep = async (imp: LockedImp, paths: ImpPaths) => {
    const seen = await sendActivity(paths.vsockSocket).then(
      (activity) => toSeenSessions(activity.sessions, new Date()),
      () => context.sessions.read(imp.id) ?? [],
    );

    return seen.map((session) => setDetached(session));
  };

  // An elastic guest gives back what it can spare before the pause, so the
  // snapshot writes less (docs/architecture/lifecycle/elastic-memory.md#sleep); returns what it
  // keeps plugged, null for an imp that does not grow.
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
      context.log(`impd: ${imp.name}: no shrink before the sleep: ${readErrorMessage(error)}`);

      return readPluggedMib(imp, paths);
    }
  };

  // what the guest holds, or will once a plug under way ends, or the most it
  // can when even that fails: the disk room and the wake's limit cover it
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

  const sleepWithRoom = async (
    imp: LockedImp,
    paths: ImpPaths,
    pid: number,
    reason: string,
    waitedMs: number,
    requestedAt: number,
  ): Promise<LockedImp> => {
    const pluggedMib = await shrinkForSleep(imp, paths);

    const ramMib = context.readSleepRamMib(pid, paths.apiSocket) ?? 0;

    const sessions = await readSessionsForSleep(imp, paths);

    const services = await sendServicesList(paths.vsockSocket, SERVICES_FOR_SLEEP_MS).catch(
      () => null,
    );

    const started = context.sleepTiming.now();

    // what the event stream reports about this sleep
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

      // its next wake restores this memory: the cold boot is news no longer
      if (booted !== null && booted.bootReason !== null) {
        writeIdentity(imp, paths, { ...booted, bootReason: null });
      }

      const sleepMs = Math.round(context.sleepTiming.now() - started);
      const waited = waitedMs > 0 ? `, waited ${String(waitedMs)}ms for a young guest` : '';

      slept.detail = {
        trigger: reason,
        durationMs: sleepMs,
        prepareMs: Math.round(started - requestedAt),
        steps: timings,
      };

      const plugged = pluggedMib === null ? '' : `, ${String(pluggedMib)} MiB plugged`;

      context.log(
        `impd: ${imp.name}: asleep in ${String(sleepMs)}ms (${reason})${waited}, ram ${String(ramMib)} MiB${plugged}, mem file ${String(readDiskMib(paths.memFile))} MiB on disk, ${formatTimings(timings)}`,
      );
    } catch (error) {
      if (context.vms.isVmAlive(pid, paths)) {
        throw error;
      }

      // a snapshot's page cache counts against the memory limit
      const isOomKill = hasOomKill();
      const message = readErrorMessage(error);
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

    // the slept event's prepareMs counts from here
    const requestedAt = context.sleepTiming.now();
    const paths = context.findPaths(imp.id);
    const pid = imp.pid;

    if (pid === null) {
      throw new Error(`${imp.name} is running without a firecracker pid`);
    }

    // the memory file is written in full before its holes are dug: first,
    // so no wait or pause starts unless the disk has room for it. The shrink
    // before the pause only lowers an elastic guest's plugged size.
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

      return sleepWithRoom(imp, paths, pid, reason, waitedMs, requestedAt);
    });

    return slept;
  };

  return sleepImpVm;
}

// allocated size: the mem file is sparse after --dig-holes
function readDiskMib(path: string): number {
  try {
    return Math.round((statSync(path).blocks * 512) / 1_048_576);
  } catch {
    return 0;
  }
}

// a sleeping imp has no client attached: the sleep closed every connection
function setDetached(session: SeenSession): SeenSession {
  return { ...session, attached: false };
}
