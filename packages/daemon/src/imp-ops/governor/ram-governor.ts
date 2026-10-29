import { EVENT_VERSION } from '@impz/api';
import type { LockFreeSleep } from '../../imps/imps/lock-free-sleep';
import type { EventBus } from '../../platform/events/event-bus';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createSemaphore } from '../../platform/process/semaphore';
import type { GrowRequest } from '../../vm/imps-contract/grow-request';
import type { AdmissionRequest, RamAdmission } from '../../vm/imps-contract/ram-admission';
import {
  buildImpOverBudgetError,
  buildNeededMib,
  buildOrdinaryBudgetError,
  buildRamBudgetError,
} from '../../vm/imps-contract/ram-budget-error';
import type { ProtectedImp } from '../../vm/imps-contract/ram-budget-error';
import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';
import type { VmRam } from '../../vm/vmm/vm-stats';
import { buildBudgets } from './build-budgets';
import type { Budgets } from './build-budgets';
import { makeCheckHugePool } from './make-check-huge-pool';
import { pickShortfall } from './pick-shortfall';
import type { Shortfall } from './pick-shortfall';
import { pickSleepVictims } from './pick-sleep-victims';

// A Firecracker VM that just booted or woke shows a small RSS for some seconds, so its reservation
// counts until the measurement catches up.
const RESERVATION_TTL_MS = 20_000;

export const ENFORCE_INTERVAL_MS = 5000;
export const ENFORCE_TRIGGER = 'RAM over budget';
const ORDINARY_TRIGGER = 'RAM outside the huge page pool';

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

  // what the host and the guests hold outside the huge page pool
  readonly ordinaryUsedMib: number;
  readonly ordinaryEffectiveMib: number;
}

type WhenShort = 'giveUp' | 'sleepAll';

interface MakeRoomOptions {
  readonly excludeId: string | null;
  readonly reason: string;
  readonly whenShort: WhenShort;
  readonly findShortfall: (usage: UsageTotals) => Shortfall;
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
  readonly readVmRam: (pid: number, apiSocket: string) => Promise<VmRam | null>;

  // The kernel keeps this count per process, so a read walks no pages. A page's share of it is never
  // less than its share of the owned RAM count, KSM or not.
  readonly readResidentRam: (pid: number, apiSocket: string) => Promise<VmRam | null>;

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
    refusal?: Partial<Pick<GovernorDecision, 'neededMib' | 'protectedCount' | 'trigger'>>,
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

  const readBudgets = (): Budgets => buildBudgets(deps.budgetMib, deps.readHugePool?.() ?? null);

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

  const checkHugePool = makeCheckHugePool({
    listAwake: deps.listAwake,
    ...(deps.readHugePool !== undefined && { readHugePool: deps.readHugePool }),
    ...(deps.readHugetlbMib !== undefined && { readHugetlbMib: deps.readHugetlbMib }),
    pendingHugePages,
    onRefused: (refusal) => {
      emitDecision({
        decision: 'refused',
        trigger: 'huge page pool',
        protectedCount: 0,
        ...refusal,
      });
    },
  });

  const readEffectiveUsage = async (
    excludeId: string | null,
    readVm: RamGovernorDeps['readVmRam'] = deps.readVmRam,
  ) => {
    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const byImp = new Map<string, number>();

    const lockedMib = deps.readLockedMib?.() ?? 0;
    let usedMib = lockedMib;
    let effectiveMib = lockedMib;
    let ordinaryUsedMib = lockedMib;
    let ordinaryEffectiveMib = lockedMib;

    const readings = await Promise.all(awake.map((imp) => readVm(imp.pid, imp.apiSocket)));

    for (const [index, imp] of awake.entries()) {
      const reading = readings[index] ?? null;
      const measured = reading?.ramMib ?? 0;
      const effective = Math.max(measured, readReservation(imp.id));

      // A guest on 2 MiB pages reserves its memory in the pool, so only what it holds beside its
      // pool pages counts outside the pool.
      const ordinary =
        imp.hugePagesMib > 0 ? Math.max(0, measured - (reading?.hugetlbMib ?? 0)) : effective;

      byImp.set(imp.id, effective);

      usedMib += measured;
      effectiveMib += effective;
      ordinaryUsedMib += imp.hugePagesMib > 0 ? ordinary : measured;
      ordinaryEffectiveMib += ordinary;
    }

    for (const id of reservations.keys()) {
      if (id !== excludeId && !byImp.has(id)) {
        effectiveMib += readReservation(id);

        if (!pendingHugePages.has(id)) {
          ordinaryEffectiveMib += readReservation(id);
        }
      }
    }

    const headroom = deps.readHeadroomMib?.(awake.map((imp) => imp.pid)) ?? Promise.resolve(0);

    const headroomMib = await headroom;

    effectiveMib += headroomMib;
    ordinaryEffectiveMib += headroomMib;

    return {
      awake,
      byImp,
      usedMib,
      effectiveMib,
      ordinaryUsedMib,
      ordinaryEffectiveMib,
      headroomMib,
    };
  };

  const readFreeRoom = async (
    excludeId: string,
    findShortfall: (usage: UsageTotals) => Shortfall,
  ): Promise<RoomOutcome> => {
    const usage = await readEffectiveUsage(excludeId);

    const missingMib = findShortfall(usage).missingMib;

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

      const shortfall = options.findShortfall(usage);
      const missingMib = shortfall.missingMib;

      // sleeping a guest on 2 MiB pages frees its pool pages, and next to nothing outside the pool
      const isOrdinary = shortfall.budget === 'ordinary';
      const sleepable = usage.awake.filter((imp) => !isOrdinary || imp.hugePagesMib === 0);

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

      const candidates = sleepable.map((imp) => ({
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
        const hugePagesMib = request.hugePagesMib ?? 0;
        const hostBudgets = readBudgets();
        const budgets = hugePagesMib > 0 ? { ...hostBudgets, ordinaryMib: null } : hostBudgets;
        const whole = pickShortfall({ ramMib: 0, ordinaryMib: 0 }, budgets, request.memoryMib);

        if (whole.missingMib > 0) {
          const usage = await readEffectiveUsage(request.id);

          const isOrdinary = whole.budget === 'ordinary';
          const usedMib = isOrdinary ? usage.ordinaryEffectiveMib : usage.effectiveMib;

          emitAdmission(request, 'refused', usedMib, {
            neededMib: buildNeededMib(usedMib, request.memoryMib, whole.budgetMib),
            protectedCount: 0,
            ...(isOrdinary && { trigger: ORDINARY_TRIGGER }),
          });

          throw buildImpOverBudgetError(whole.budget, {
            budgetMib: whole.budgetMib,
            usedMib,
            requestedMib: request.memoryMib,
          });
        }

        if (hugePagesMib > 0) {
          await checkHugePool(request, hugePagesMib);
        }

        const bound = await readEffectiveUsage(request.id, deps.readResidentRam);

        if (pickEffectiveShortfall(bound, budgets, request.reserveMib).missingMib <= 0) {
          recordAdmission(request, bound.effectiveMib);

          return;
        }

        const findReserveShortfall = (usage: UsageTotals) =>
          pickEffectiveShortfall(usage, budgets, request.reserveMib);

        const room =
          request.maySleepImps === false
            ? await readFreeRoom(request.id, findReserveShortfall)
            : await makeRoom({
                excludeId: request.id,
                reason: `to make room for ${request.name ?? request.id}`,
                whenShort: 'giveUp',
                findShortfall: findReserveShortfall,
              });

        const diskFull = room.diskFull ? (deps.readDiskFullError?.() ?? null) : null;

        if (!room.fits && diskFull !== null) {
          throw diskFull;
        }

        if (!room.fits) {
          const usage = await readEffectiveUsage(request.id);

          const shortfall = findReserveShortfall(usage);
          const isOrdinary = shortfall.budget === 'ordinary';

          emitAdmission(request, 'refused', shortfall.usedMib, {
            neededMib: buildNeededMib(shortfall.usedMib, request.reserveMib, shortfall.budgetMib),
            protectedCount: room.protected.length,
            ...(isOrdinary && { trigger: ORDINARY_TRIGGER }),
          });

          const refusal = {
            budgetMib: shortfall.budgetMib,
            usedMib: shortfall.usedMib,
            requestedMib: request.reserveMib,
            protected: room.protected,
          };

          throw isOrdinary ? buildOrdinaryBudgetError(refusal) : buildRamBudgetError(refusal);
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

        const budgets = readBudgets();

        const room = await makeRoom({
          excludeId: null,
          reason: `to grow ${request.name}`,
          whenShort: 'giveUp',
          findShortfall: (usage) => pickEffectiveShortfall(usage, budgets, request.mib),
          protectedId: request.id,
        });

        const usage = await readEffectiveUsage(null);

        const shortfall = pickEffectiveShortfall(usage, budgets, request.mib);
        const fits = room.fits && usage.awake.some((imp) => imp.id === request.id);

        emitDecision({
          decision: fits ? 'admitted' : 'refused',
          name: request.name,
          trigger: 'grow',
          usedMib: shortfall.usedMib,
          reserveMib: request.mib,
          ...(!fits && {
            neededMib: Math.max(0, shortfall.missingMib),
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
        const budgets = readBudgets();

        const room = await makeRoom({
          excludeId: null,
          reason: ENFORCE_TRIGGER,
          whenShort: 'sleepAll',
          findShortfall: (usage) =>
            pickShortfall(
              { ramMib: usage.usedMib, ordinaryMib: usage.ordinaryUsedMib },
              budgets,
              0,
            ),
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

function pickEffectiveShortfall(
  usage: UsageTotals,
  budgets: Readonly<Budgets>,
  requestedMib: number,
): Shortfall {
  return pickShortfall(
    { ramMib: usage.effectiveMib, ordinaryMib: usage.ordinaryEffectiveMib },
    budgets,
    requestedMib,
  );
}
