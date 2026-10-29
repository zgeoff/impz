import { EVENT_VERSION } from '@impz/api';
import type { LockFreeSleep } from '../../imps/imps/lock-free-sleep';
import type { EventBus } from '../../platform/events/event-bus';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createSemaphore } from '../../platform/process/semaphore';
import type { GrowRequest } from '../../vm/imps-contract/grow-request';
import type { AdmissionRequest, RamAdmission } from '../../vm/imps-contract/ram-admission';
import {
  buildHugePoolError,
  buildImpOverBudgetError,
  buildNeededMib,
  buildRamBudgetError,
} from '../../vm/imps-contract/ram-budget-error';
import type { ProtectedImp } from '../../vm/imps-contract/ram-budget-error';
import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';
import { pickSleepVictims } from './pick-sleep-victims';

// A Firecracker VM that just booted or woke shows a small RSS for some seconds, so its reservation
// counts until the measurement catches up.
const RESERVATION_TTL_MS = 20_000;

export const ENFORCE_INTERVAL_MS = 5000;
export const ENFORCE_TRIGGER = 'RAM over budget';

interface AwakeImp {
  readonly id: string;
  readonly name: string;
  readonly pid: number;
  readonly apiSocket: string;
  readonly lastActiveAt: number;
  readonly holdUntil: number | null;

  // the memory of a guest on 2 MiB pages, all of which it may take from the pool
  readonly hugePagesMib: number;
}

interface UsageTotals {
  readonly usedMib: number;
  readonly effectiveMib: number;
}

type WhenShort = 'giveUp' | 'sleepAll';

interface MakeRoomOptions {
  readonly excludeId: string | null;
  readonly reason: string;
  readonly whenShort: WhenShort;
  readonly findMissing: (usage: UsageTotals) => number;
  readonly protectedId?: string | null;
}

interface GovernorDecision {
  readonly decision: 'admitted' | 'refused' | 'slept';
  readonly name: string;
  readonly trigger: string;
  readonly usedMib: number;
  readonly reserveMib?: number;
  readonly neededMib?: number;
  readonly protectedCount?: number;
}

interface RoomOutcome {
  readonly fits: boolean;
  readonly slept: number;
  readonly diskFull: boolean;
  readonly missingMib: number;
  readonly effectiveMib: number;
  readonly protected: readonly ProtectedImp[];
}

interface RamUsage {
  readonly usedMib: number;
  readonly reservedMib: number;
  readonly headroomMib: number;
}

export interface RamGovernor extends RamAdmission {
  readonly readUsage: () => Promise<RamUsage>;
  readonly admitGrow: (request: GrowRequest) => Promise<boolean>;
  readonly releaseGrow: (id: string) => void;
  readonly enforce: () => Promise<void>;
}

export interface RamGovernorDeps {
  readonly budgetMib: number;
  readonly listAwake: () => Promise<AwakeImp[]>;
  readonly readRamMib: (pid: number, apiSocket: string) => Promise<number | null>;

  // The kernel keeps this count per process, so a read walks no pages. A page's share of it is never
  // less than its share of the owned RAM count, KSM or not.
  readonly readResidentMib: (pid: number, apiSocket: string) => Promise<number | null>;

  // Writes split pages that KSM merged faster than a tick, so a share of what KSM saves stays free.
  readonly readHeadroomMib?: (pids: readonly number[]) => Promise<number>;

  // Locked host memory outside any VM, such as boot templates' pages: no sleep frees it.
  readonly readLockedMib?: () => number;

  // Firecracker maps a 2 MiB guest's memory with MAP_NORESERVE, so a guest that
  // faults on an empty pool dies of SIGBUS, at any time after its boot.
  readonly readHugePool?: () => HugePagePool | null;
  readonly readHugetlbMib?: (pid: number, apiSocket: string) => Promise<number | null>;
  readonly isBusy: (id: string) => boolean;
  readonly trySleepImp: LockFreeSleep;
  readonly readDiskFullError?: () => Error | null;
  readonly now?: () => number;
  readonly events?: EventBus;
  readonly reclaim?: (excludeId: string | null) => Promise<number>;
}

interface Reservation {
  readonly mib: number;
  readonly until: number;
}

export function createRamGovernor(deps: RamGovernorDeps): RamGovernor {
  const admission = createSemaphore(1);

  const reservations = new Map<
    string,
    Reservation & { readonly beforeGrow?: Reservation | null }
  >();

  const now = deps.now ?? Date.now;
  let stuckOver = false;

  // admitted guests on 2 MiB pages that are not awake yet, by imp
  const pendingHugePages = new Map<string, number>();

  const emitDecision = (decision: GovernorDecision): void => {
    deps.events?.publish({
      // oxlint-disable-next-line id-length -- `v` is the event format's version field
      v: EVENT_VERSION,
      at: new Date(now()),
      ev: 'GovernorDecision',
      budgetMib: deps.budgetMib,
      ...decision,
    });
  };

  const emitAdmission = (
    request: AdmissionRequest,
    decision: 'admitted' | 'refused',
    usedMib: number,
    refusal?: Pick<GovernorDecision, 'neededMib' | 'protectedCount'>,
  ): void => {
    if (request.name !== null) {
      emitDecision({
        decision,
        name: request.name,
        trigger: 'admission',
        usedMib,
        reserveMib: request.reserveMib,
        ...refusal,
      });
    }
  };

  const recordAdmission = (request: AdmissionRequest, usedMib: number): void => {
    reservations.set(request.id, {
      mib: request.reserveMib,
      until: now() + RESERVATION_TTL_MS,
    });

    if ((request.hugePagesMib ?? 0) > 0) {
      pendingHugePages.set(request.id, request.hugePagesMib ?? 0);
    }

    emitAdmission(request, 'admitted', usedMib);
  };

  const readReservation = (id: string): number => {
    const reservation = reservations.get(id);

    if (reservation === undefined) {
      return 0;
    }

    if (reservation.until < now()) {
      reservations.delete(id);

      return 0;
    }

    return reservation.mib;
  };

  // An awake guest may still take every block of its memory it has not touched,
  // so the pool must hold those as well as the whole of the new guest.
  const checkHugePool = async (request: AdmissionRequest, hugePagesMib: number): Promise<void> => {
    const pool = deps.readHugePool?.() ?? null;

    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== request.id);

    for (const imp of awake) {
      pendingHugePages.delete(imp.id);
    }

    const onPages = awake.filter((imp) => imp.hugePagesMib > 0);

    const held = await Promise.all(
      onPages.map((imp) => deps.readHugetlbMib?.(imp.pid, imp.apiSocket) ?? Promise.resolve(0)),
    );

    const growthMib = onPages.reduce(
      (sum, imp, index) => sum + Math.max(0, imp.hugePagesMib - (held[index] ?? 0)),
      0,
    );

    const pendingMib = [...pendingHugePages]
      .filter(([id]) => id !== request.id)
      .reduce((sum, [, mib]) => sum + mib, 0);

    const freeMib = pool?.freeMib ?? 0;
    const committedMib = (pool?.totalMib ?? 0) - freeMib + growthMib + pendingMib;

    if (growthMib + pendingMib + hugePagesMib <= freeMib) {
      return;
    }

    if (request.name !== null) {
      emitDecision({
        decision: 'refused',
        name: request.name,
        trigger: 'huge page pool',
        usedMib: committedMib,
        reserveMib: hugePagesMib,
        neededMib: growthMib + pendingMib + hugePagesMib - freeMib,
        protectedCount: 0,
      });
    }

    throw buildHugePoolError({
      totalMib: pool?.totalMib ?? 0,
      committedMib,
      requestedMib: hugePagesMib,
    });
  };

  const readEffectiveUsage = async (
    excludeId: string | null,
    readVmMib: RamGovernorDeps['readRamMib'] = deps.readRamMib,
  ) => {
    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const byImp = new Map<string, number>();

    const lockedMib = deps.readLockedMib?.() ?? 0;
    let usedMib = lockedMib;
    let effectiveMib = lockedMib;

    const readings = await Promise.all(awake.map((imp) => readVmMib(imp.pid, imp.apiSocket)));

    for (const [index, imp] of awake.entries()) {
      const measured = readings[index] ?? 0;
      const effective = Math.max(measured, readReservation(imp.id));

      byImp.set(imp.id, effective);

      usedMib += measured;
      effectiveMib += effective;
    }

    for (const id of reservations.keys()) {
      if (id !== excludeId && !byImp.has(id)) {
        effectiveMib += readReservation(id);
      }
    }

    const headroom = deps.readHeadroomMib?.(awake.map((imp) => imp.pid)) ?? Promise.resolve(0);

    const headroomMib = await headroom;

    effectiveMib += headroomMib;

    return { awake, byImp, usedMib, effectiveMib, headroomMib };
  };

  const readFreeRoom = async (
    excludeId: string,
    findMissing: (usage: UsageTotals) => number,
  ): Promise<RoomOutcome> => {
    const usage = await readEffectiveUsage(excludeId);

    const missingMib = findMissing(usage);

    return {
      fits: missingMib <= 0,
      slept: 0,
      diskFull: false,
      missingMib,
      effectiveMib: usage.effectiveMib,
      protected: [],
    };
  };

  const makeRoom = async (options: MakeRoomOptions): Promise<RoomOutcome> => {
    const excludeId = options.excludeId;
    const reason = options.reason;
    const protectedId = options.protectedId ?? null;
    const pinned = protectedId === null ? [] : [protectedId];

    const passed = new Set<string>(pinned);

    const reclaim = { isDone: false };
    let slept = 0;
    let diskFull = false;

    for (;;) {
      const usage = await readEffectiveUsage(excludeId);

      const missingMib = options.findMissing(usage);

      if (missingMib <= 0) {
        return {
          fits: true,
          slept,
          diskFull,
          missingMib,
          effectiveMib: usage.effectiveMib,
          protected: [],
        };
      }

      if (!reclaim.isDone && deps.reclaim !== undefined) {
        reclaim.isDone = true;

        const freedMib = await deps.reclaim(excludeId ?? protectedId);

        if (freedMib > 0) {
          getImpdLogger('governor').info('unplugged {freedMib} MiB from idle imps ({reason})', {
            freedMib: String(freedMib),
            reason,
          });
        }

        continue;
      }

      const time = now();

      const candidates = usage.awake.map((imp) => ({
        id: imp.id,
        name: imp.name,
        ramMib: usage.byImp.get(imp.id) ?? 0,
        lastActiveAt: imp.lastActiveAt,
        held: imp.holdUntil !== null && imp.holdUntil > time,
        busy: deps.isBusy(imp.id) || passed.has(imp.id),
      }));

      const picked = pickSleepVictims(candidates, missingMib);
      const [victim] = picked.victims;

      if (victim === undefined || (!picked.enough && options.whenShort === 'giveUp')) {
        return {
          fits: false,
          slept,
          diskFull,
          missingMib,
          effectiveMib: usage.effectiveMib,
          protected: candidates
            .filter((candidate) => candidate.id !== protectedId)
            .filter((candidate) => candidate.held || candidate.busy)
            .map((candidate) => ({
              name: candidate.name,
              ramMib: candidate.ramMib,
              leased: candidate.held,
              busy: candidate.busy,
            })),
        };
      }

      const outcome = await deps.trySleepImp(victim.id, reason, { by: 'governor' });

      if (outcome === 'slept') {
        reservations.delete(victim.id);

        slept += 1;

        emitDecision({
          decision: 'slept',
          name: victim.name,
          trigger: reason,
          usedMib: usage.effectiveMib,
        });
      } else {
        passed.add(victim.id);

        diskFull ||= outcome === 'diskFull';
      }
    }
  };

  return {
    admit: (request) =>
      admission.run(async () => {
        if (request.memoryMib > deps.budgetMib) {
          const usage = await readEffectiveUsage(request.id);

          emitAdmission(request, 'refused', usage.effectiveMib, {
            neededMib: buildNeededMib(usage.effectiveMib, request.memoryMib, deps.budgetMib),
            protectedCount: 0,
          });

          throw buildImpOverBudgetError(deps.budgetMib, usage.effectiveMib, request.memoryMib);
        }

        const hugePagesMib = request.hugePagesMib ?? 0;

        if (hugePagesMib > 0) {
          await checkHugePool(request, hugePagesMib);
        }

        const bound = await readEffectiveUsage(request.id, deps.readResidentMib);

        if (bound.effectiveMib + request.reserveMib <= deps.budgetMib) {
          recordAdmission(request, bound.effectiveMib);

          return;
        }

        const findMissing = (usage: UsageTotals) =>
          usage.effectiveMib + request.reserveMib - deps.budgetMib;

        const room =
          request.maySleepImps === false
            ? await readFreeRoom(request.id, findMissing)
            : await makeRoom({
                excludeId: request.id,
                reason: `to make room for ${request.name ?? request.id}`,
                whenShort: 'giveUp',
                findMissing,
              });

        const diskFull = room.diskFull ? (deps.readDiskFullError?.() ?? null) : null;

        if (!room.fits && diskFull !== null) {
          throw diskFull;
        }

        if (!room.fits) {
          const usage = await readEffectiveUsage(request.id);

          emitAdmission(request, 'refused', usage.effectiveMib, {
            neededMib: buildNeededMib(usage.effectiveMib, request.reserveMib, deps.budgetMib),
            protectedCount: room.protected.length,
          });

          throw buildRamBudgetError({
            budgetMib: deps.budgetMib,
            usedMib: usage.effectiveMib,
            requestedMib: request.reserveMib,
            protected: room.protected,
          });
        }

        recordAdmission(request, room.effectiveMib);
      }),

    release: (id) => {
      reservations.delete(id);
      pendingHugePages.delete(id);
    },

    admitGrow: (request) =>
      admission.run(async () => {
        const listed = await deps.listAwake();

        if (!listed.some((imp) => imp.id === request.id)) {
          return false;
        }

        const room = await makeRoom({
          excludeId: null,
          reason: `to grow ${request.name}`,
          whenShort: 'giveUp',
          findMissing: (usage) => usage.effectiveMib + request.mib - deps.budgetMib,
          protectedId: request.id,
        });

        const usage = await readEffectiveUsage(null);

        const fits = room.fits && usage.awake.some((imp) => imp.id === request.id);

        emitDecision({
          decision: fits ? 'admitted' : 'refused',
          name: request.name,
          trigger: 'grow',
          usedMib: usage.effectiveMib,
          reserveMib: request.mib,
          ...(!fits && {
            neededMib: buildNeededMib(usage.effectiveMib, request.mib, deps.budgetMib),
            protectedCount: room.protected.length,
          }),
        });

        if (!fits) {
          return false;
        }

        const before = reservations.get(request.id);

        reservations.set(request.id, {
          mib: (usage.byImp.get(request.id) ?? 0) + request.mib,
          until: now() + RESERVATION_TTL_MS,
          beforeGrow: before === undefined ? null : { mib: before.mib, until: before.until },
        });

        return true;
      }),

    releaseGrow: (id) => {
      const reservation = reservations.get(id);

      if (reservation?.beforeGrow === undefined) {
        return;
      }

      if (reservation.beforeGrow === null) {
        reservations.delete(id);
      } else {
        reservations.set(id, reservation.beforeGrow);
      }
    },

    readUsage: async () => {
      const usage = await readEffectiveUsage(null);

      return {
        usedMib: usage.usedMib,
        reservedMib: usage.effectiveMib - usage.usedMib - usage.headroomMib,
        headroomMib: usage.headroomMib,
      };
    },

    enforce: () =>
      admission.run(async () => {
        const room = await makeRoom({
          excludeId: null,
          reason: ENFORCE_TRIGGER,
          whenShort: 'sleepAll',
          findMissing: (usage) => usage.usedMib - deps.budgetMib,
        });

        const over = `over budget by ${String(room.missingMib)} MiB`;

        if (room.fits) {
          stuckOver = false;
        } else if (room.slept > 0) {
          getImpdLogger('governor').info('slept {slept}, RAM still {over}', {
            slept: String(room.slept),
            over,
          });

          stuckOver = true;
        } else if (!stuckOver) {
          getImpdLogger('governor').info('RAM {over} and no idle imp left to sleep', { over });

          stuckOver = true;
        }
      }),
  };
}
