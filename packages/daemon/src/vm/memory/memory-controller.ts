import {
  buildAgentOutdatedError,
  buildAgentUnknownError,
  hasFeature,
} from '../agent-client/agent-outdated';
import type { GrowRequest } from '../imps-contract/grow-request';
import type { ImpPaths } from '../storage/data-layout';
import { GROW_STEP_MIB, getLowMib, getRegionMib, getStructPageMib } from '../vmm/elastic-memory';
import type { GuestMemory, VmRunner } from '../vmm/vm-runner';
import type { MemoryLimit } from './memory-limit';
import { getShrinkTargetMib, shrinkGuest } from './shrink-guest';

const SHRINK_AFTER_MS = 60_000;
const BACKOFF_MS = 60_000;
const RECLAIM_TIME_LIMIT_MS = 1000;
const STALL_MS = 2000;

// Firecracker's balloon statistics count a plug at their next poll, at most 1 s after it lands, so
// a grow they still miss after this long stops holding back the next one.
const GROW_UNCOUNTED_MS = 3000;

/* @internal */
export interface ElasticImp {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly memoryMib: number;
  readonly maxMemoryMib: number;
  readonly paths: ImpPaths;
  readonly agentVersion: string | undefined;
}

export interface MemoryControllerDeps {
  readonly listElastic: () => Promise<readonly ElasticImp[]>;
  readonly vms: Pick<VmRunner, 'readGuestMemory' | 'requestPluggedMib'>;
  readonly isLocked: (id: string) => boolean;
  readonly isBusy: (id: string) => boolean;

  // A plug or an unplug runs under the imp's lifecycle lock, so a sleep never snapshots a guest
  // whose size is changing.
  readonly tryWhileRunning: (id: string, action: () => Promise<void>) => Promise<boolean>;
  readonly admitGrow: (request: GrowRequest) => Promise<boolean>;
  readonly releaseGrow: (id: string) => void;
  readonly limit: MemoryLimit;
  readonly readRamMib: (imp: ElasticImp) => number | null;
  readonly setPluggedMib: (id: string, mib: number | null) => void;
  readonly log: (message: string) => void;
  readonly now?: () => number;
  readonly sleep?: (durationMs: number) => Promise<void>;
}

interface ImpState {
  spareSince: number | null;
  shrinkAfter: number;
  growAfter: number;
  change: { pluggedMib: number; since: number } | null;
  uncountedGrow: { totalMib: number; until: number | null } | null;
  stalledAtMib: number | null;
  lowerTo: number | null;
  isRefused: boolean;
  isAgentOutdated: boolean;
}

export interface MemoryController {
  readonly runTick: () => Promise<void>;
  readonly reclaimIdle: (excludeId: string | null) => Promise<number>;
}

export function createMemoryController(deps: MemoryControllerDeps): MemoryController {
  const now = deps.now ?? Date.now;

  const states = new Map<string, ImpState>();

  const readState = (imp: ElasticImp, memory: Readonly<GuestMemory>): ImpState => {
    const known = states.get(imp.id);

    if (known !== undefined) {
      return known;
    }

    const created: ImpState = {
      spareSince: null,
      shrinkAfter: 0,
      growAfter: 0,
      change: null,
      uncountedGrow: null,
      stalledAtMib: null,
      lowerTo: null,
      isRefused: false,
      isAgentOutdated: false,
    };

    states.set(imp.id, created);

    deps.limit.setGuestMib(
      imp.id,
      imp.memoryMib + Math.max(memory.pluggedMib, memory.requestedMib),
    );

    return created;
  };

  const applyLowerLimit = (imp: ElasticImp, memory: Readonly<GuestMemory>): void => {
    const state = readState(imp, memory);

    if (state.lowerTo === null || memory.requestedMib > memory.pluggedMib) {
      return;
    }

    const guestMib = imp.memoryMib + memory.pluggedMib;

    if (memory.pluggedMib > state.lowerTo || (deps.readRamMib(imp) ?? guestMib) > guestMib) {
      return;
    }

    deps.limit.setGuestMib(imp.id, guestMib);

    state.lowerTo = null;
  };

  const sendLocked = (imp: ElasticImp, mib: number) =>
    deps.tryWhileRunning(imp.id, () => deps.vms.requestPluggedMib(imp.paths, mib));

  const growImp = async (imp: ElasticImp, memory: Readonly<GuestMemory>) => {
    const state = readState(imp, memory);

    const capMib = Math.min(
      getRegionMib(imp.memoryMib, imp.maxMemoryMib),
      imp.maxMemoryMib - imp.memoryMib,
    );

    const stepMib = Math.min(GROW_STEP_MIB, capMib - memory.pluggedMib);

    if (stepMib <= 0) {
      return;
    }

    if (!hasFeature(imp.agentVersion, 'elastic-memory')) {
      if (!state.isAgentOutdated) {
        const error =
          imp.agentVersion === undefined
            ? buildAgentUnknownError('elastic-memory')
            : buildAgentOutdatedError('elastic-memory');

        deps.log(`impd: ${imp.name}: memory low, not grown: ${error.detail}`);
      }

      state.isAgentOutdated = true;

      return;
    }

    const admitted = await deps.admitGrow({
      id: imp.id,
      name: imp.name,
      mib: stepMib + getStructPageMib(stepMib),
    });

    if (!admitted) {
      if (!state.isRefused) {
        deps.log(
          `impd: ${imp.name}: memory low (${String(memory.availableMib)} MiB free), and the RAM budget has no room to grow it`,
        );
      }

      state.isRefused = true;

      return;
    }

    state.isRefused = false;

    const pluggedMib = memory.pluggedMib + stepMib;

    // The host's memory limit rises before the plug, so the guest never takes memory the host has
    // not yet allowed it.
    const isRequested = await deps.tryWhileRunning(imp.id, async () => {
      deps.limit.setGuestMib(imp.id, imp.memoryMib + pluggedMib);

      await sendPlug(imp, memory, pluggedMib);
    });

    if (!isRequested) {
      deps.releaseGrow(imp.id);

      return;
    }

    state.lowerTo = null;

    // The guest kernel's struct pages for the plugged step can come out of the total it reports.
    state.uncountedGrow = {
      totalMib:
        Math.max(memory.totalMib, state.uncountedGrow?.totalMib ?? 0) +
        stepMib -
        getStructPageMib(stepMib),
      until: null,
    };

    deps.log(
      `impd: ${imp.name}: memory low (${String(memory.availableMib)} of ${String(memory.totalMib)} MiB free), grew to ${String(imp.memoryMib + pluggedMib)} MiB`,
    );
  };

  // A failed request to Firecracker may still have landed with its answer lost, so the guest's
  // requested size decides, and a guest that cannot be read counts as one where it landed.
  const sendPlug = async (imp: ElasticImp, memory: Readonly<GuestMemory>, pluggedMib: number) => {
    try {
      await deps.vms.requestPluggedMib(imp.paths, pluggedMib);
    } catch (error) {
      const seen = await deps.vms.readGuestMemory(imp.paths).catch(() => null);

      if (seen === null || seen.requestedMib === pluggedMib) {
        return;
      }

      deps.releaseGrow(imp.id);
      deps.limit.setGuestMib(imp.id, imp.memoryMib + memory.pluggedMib);
      throw error;
    }
  };

  const shrinkImp = async (imp: ElasticImp, memory: Readonly<GuestMemory>) => {
    const state = readState(imp, memory);
    const targetMib = getShrinkTargetMib(memory);

    state.spareSince = null;

    if (!(await sendLocked(imp, targetMib))) {
      return;
    }

    state.lowerTo = targetMib;
    state.uncountedGrow = null;

    deps.log(
      `impd: ${imp.name}: memory to spare, shrinking to ${String(imp.memoryMib + targetMib)} MiB`,
    );
  };

  const checkChange = async (imp: ElasticImp, memory: Readonly<GuestMemory>, time: number) => {
    const state = readState(imp, memory);

    if (state.change?.pluggedMib !== memory.pluggedMib) {
      state.change = { pluggedMib: memory.pluggedMib, since: time };

      return;
    }

    if (time - state.change.since < STALL_MS) {
      return;
    }

    const isPlug = memory.requestedMib > memory.pluggedMib;

    if (!(await sendLocked(imp, memory.pluggedMib))) {
      return;
    }

    const guestMib = String(imp.memoryMib + memory.pluggedMib);

    state.change = null;
    state.lowerTo = memory.pluggedMib;

    if (!isPlug) {
      state.shrinkAfter = time + BACKOFF_MS;

      deps.log(`impd: ${imp.name}: the guest could not unplug below ${guestMib} MiB`);

      return;
    }

    state.growAfter = time + BACKOFF_MS;
    state.uncountedGrow = null;

    if (state.stalledAtMib === null) {
      deps.log(`impd: ${imp.name}: the guest could not plug past ${guestMib} MiB`);
    }

    state.stalledAtMib = memory.pluggedMib;
  };

  const checkImp = async (imp: ElasticImp): Promise<void> => {
    const memory = await deps.vms.readGuestMemory(imp.paths);

    const state = readState(imp, memory);
    const time = now();

    deps.setPluggedMib(imp.id, memory.pluggedMib);

    if (memory.requestedMib !== memory.pluggedMib) {
      await checkChange(imp, memory, time);

      return;
    }

    state.change = null;

    if (memory.pluggedMib !== state.stalledAtMib) {
      state.stalledAtMib = null;
    }

    applyLowerLimit(imp, memory);

    if (state.uncountedGrow !== null) {
      state.uncountedGrow.until ??= time + GROW_UNCOUNTED_MS;

      if (memory.totalMib >= state.uncountedGrow.totalMib) {
        state.uncountedGrow = null;
      }
    }

    const held = state.uncountedGrow;
    const isGrowHeld = held !== null && held.until !== null && time < held.until;

    if (memory.availableMib < getLowMib(memory.totalMib)) {
      state.spareSince = null;

      if (time >= state.growAfter && !isGrowHeld) {
        await growImp(imp, memory);
      }

      return;
    }

    const isSpare =
      memory.pluggedMib - getShrinkTargetMib(memory) >= GROW_STEP_MIB && time >= state.shrinkAfter;

    if (!isSpare) {
      state.spareSince = null;

      return;
    }

    state.spareSince ??= time;

    if (time - state.spareSince >= SHRINK_AFTER_MS) {
      await shrinkImp(imp, memory);
    }
  };

  return {
    runTick: async () => {
      const imps = await deps.listElastic();

      const seen = new Set(imps.map((imp) => imp.id));

      for (const id of states.keys()) {
        if (!seen.has(id)) {
          states.delete(id);
          deps.setPluggedMib(id, null);
        }
      }

      for (const imp of imps) {
        if (deps.isLocked(imp.id)) {
          continue;
        }

        try {
          await checkImp(imp);
        } catch {
          // a VM that is pausing or gone; the next tick looks again
        }
      }
    },
    reclaimIdle: async (excludeId) => {
      const imps = await deps.listElastic();

      const idle = imps.filter((imp) => imp.id !== excludeId && !deps.isBusy(imp.id));

      const shrinkIdleImp = async (imp: ElasticImp): Promise<number> => {
        const freed = { mib: 0 };

        await deps.tryWhileRunning(imp.id, async () => {
          const shrunk = await shrinkGuest(deps.vms, imp.paths, {
            timeLimitMs: RECLAIM_TIME_LIMIT_MS,
            ...(deps.sleep !== undefined && { sleep: deps.sleep }),
            now,
          });

          const afterMib = shrunk.pluggedMib;

          deps.setPluggedMib(imp.id, afterMib);

          const state = states.get(imp.id);

          if (state !== undefined && afterMib < shrunk.reachedMib) {
            state.lowerTo = afterMib;
            state.uncountedGrow = null;
          } else if (
            state !== undefined &&
            state.uncountedGrow !== null &&
            afterMib < shrunk.before.requestedMib
          ) {
            state.uncountedGrow.totalMib -= shrunk.before.requestedMib - afterMib;
          }

          freed.mib = Math.max(0, shrunk.reachedMib - afterMib);
        });

        return freed.mib;
      };

      const freed = await Promise.all(idle.map((imp) => shrinkIdleImp(imp).catch(() => 0)));

      return freed.reduce((sum, mib) => sum + mib, 0);
    },
  };
}
