import { EVENT_VERSION, isImpAllowed } from '@impz/api';
import type { LockFreeSleep } from '../../imps/imps/lock-free-sleep';
import type { EventBus } from '../../platform/events/event-bus';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import { createPrioritySemaphore } from '../../platform/process/priority-semaphore';
import type { TaskPriority } from '../../platform/process/priority-semaphore';
import type { GrowRequest } from '../../vm/imps-contract/grow-request';
import type { AdmissionRequest, RamAdmission } from '../../vm/imps-contract/ram-admission';
import {
  buildImpOverBudgetError,
  buildNeededMib,
  buildOrdinaryBudgetError,
  buildRamBudgetError,
} from '../../vm/imps-contract/ram-budget-error';
import type { ProtectedImp } from '../../vm/imps-contract/ram-budget-error';
import type { PriorityRam } from '../../vm/vm-config';
import type { HugePagePool } from '../../vm/vmm/read-huge-page-pool';
import type { VmRam } from '../../vm/vmm/vm-stats';
import { buildBudgets } from './build-budgets';
import type { Budgets } from './build-budgets';
import { buildUsageTotals } from './build-usage-totals';
import type { UsageTotals } from './build-usage-totals';
import { makeCheckHugePool } from './make-check-huge-pool';
import { pickEffectiveShortfall } from './pick-effective-shortfall';
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

type WhenShort = 'giveUp' | 'sleepAll';

interface MakeRoomOptions {
  readonly excludeId: string | null;
  readonly reason: string;
  readonly whenShort: WhenShort;
  readonly findShortfall: (usage: UsageTotals) => Shortfall;
  readonly protectedId?: string | null;

  // a priority imp asleep leaves its RAM kept all the same, so sleeping it frees nothing for others
  readonly sparesPriority: boolean;
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
  readonly priorityKeptMib: number;
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
  readonly priority?: PriorityRam | null;
}

interface Reservation {
  readonly mib: number;
  readonly until: number;
}

export function createRamGovernor(deps: RamGovernorDeps): RamGovernor {
  const admission = createPrioritySemaphore(1);

  const reservations = new Map<
    string,
    Reservation & { readonly beforeGrow?: Reservation | null }
  >();

  const now = deps.now ?? Date.now;
  const priority = deps.priority ?? null;

  const isPriority = (name: string | null): boolean =>
    priority !== null && name !== null && isImpAllowed(priority.patterns, name);

  const buildKept = (mib: number): PriorityRam | null =>
    priority === null || mib === 0 ? null : { mib, patterns: priority.patterns };

  let stuckOver = false;

  // admitted guests on 2 MiB pages that are not awake yet, by imp
  const pendingHugePages = new Map<string, number>();

  // the admitted priority imps, whose reservations and pool pages count against the kept RAM
  // until each is awake
  const admittedPriority = new Set<string>();

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

    if (isPriority(request.name)) {
      admittedPriority.add(request.id);
    } else {
      admittedPriority.delete(request.id);
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
    const lockedMib = deps.readLockedMib?.() ?? 0;

    const readings = await Promise.all(awake.map((imp) => readVm(imp.pid, imp.apiSocket)));

    const live = [...reservations.keys()]
      .filter((id) => id !== excludeId)
      .map((id) => ({
        id,
        mib: readReservation(id),
        isPriority: admittedPriority.has(id),
        isOnPool: pendingHugePages.has(id),
      }));

    const pendingPool = [...pendingHugePages]
      .filter(([id]) => id !== excludeId)
      .map(([id, mib]) => ({ id, mib, isPriority: admittedPriority.has(id) }));

    const headroom = deps.readHeadroomMib?.(awake.map((imp) => imp.pid)) ?? Promise.resolve(0);

    const headroomMib = await headroom;

    const totals = buildUsageTotals({
      awake: awake.map((imp) => ({ ...imp, isPriority: isPriority(imp.name) })),
      readings,
      reservations: live,
      pendingPool,
      lockedMib,
      headroomMib,
      priorityMib: priority?.mib ?? 0,
    });

    return { awake, headroomMib, ...totals };
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

      const sleepable = usage.awake
        .filter((imp) => !isOrdinary || imp.hugePagesMib === 0)
        .filter((imp) => !options.sparesPriority || !isPriority(imp.name));

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
      admission.run(toTaskPriority(request), async () => {
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

        const bound = await readEffectiveUsage(request.id, deps.readResidentRam);

        const isPriorityRequest = isPriority(request.name);

        if (hugePagesMib > 0) {
          const kept = isPriorityRequest ? null : buildKept(bound.kept.poolMib);

          await checkHugePool(request, hugePagesMib, kept);
        }

        const findReserveShortfall = (usage: UsageTotals) =>
          pickEffectiveShortfall(usage, budgets, request.reserveMib, isPriorityRequest);

        if (findReserveShortfall(bound).missingMib <= 0) {
          recordAdmission(request, bound.effectiveMib);

          return;
        }

        const room =
          request.maySleepImps === false
            ? await readFreeRoom(request.id, findReserveShortfall)
            : await makeRoom({
                excludeId: request.id,
                reason: `to make room for ${request.name ?? request.id}`,
                whenShort: 'giveUp',
                findShortfall: findReserveShortfall,
                sparesPriority: !isPriorityRequest,
              });

        const diskFull = room.diskFull ? (deps.readDiskFullError?.() ?? null) : null;

        if (!room.fits && diskFull !== null) {
          throw diskFull;
        }

        if (!room.fits) {
          const usage = await readEffectiveUsage(request.id);

          const shortfall = findReserveShortfall(usage);
          const isOrdinary = shortfall.budget === 'ordinary';
          const kept = buildKept(shortfall.keptMib);

          emitAdmission(request, 'refused', shortfall.usedMib, {
            neededMib: Math.max(0, shortfall.missingMib),
            protectedCount: room.protected.length,
            ...(isOrdinary && { trigger: ORDINARY_TRIGGER }),
          });

          const refusal = {
            budgetMib: shortfall.budgetMib,
            usedMib: shortfall.usedMib,
            requestedMib: request.reserveMib,
            protected: room.protected,
            ...(kept !== null && { kept }),
          };

          throw isOrdinary ? buildOrdinaryBudgetError(refusal) : buildRamBudgetError(refusal);
        }

        recordAdmission(request, room.effectiveMib);
      }),

    release: (id) => {
      reservations.delete(id);
      pendingHugePages.delete(id);
      admittedPriority.delete(id);
    },

    admitGrow: (request) =>
      admission.run('background', async () => {
        const listed = await deps.listAwake();

        if (!listed.some((imp) => imp.id === request.id)) {
          return false;
        }

        const budgets = readBudgets();

        const findGrowShortfall = (usage: UsageTotals) =>
          pickEffectiveShortfall(usage, budgets, request.mib, isPriority(request.name));

        const room = await makeRoom({
          excludeId: null,
          reason: `to grow ${request.name}`,
          whenShort: 'giveUp',
          findShortfall: findGrowShortfall,
          protectedId: request.id,
          sparesPriority: !isPriority(request.name),
        });

        const usage = await readEffectiveUsage(null);

        const shortfall = findGrowShortfall(usage);
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
        priorityKeptMib: usage.kept.ramMib,
      };
    },

    enforce: () =>
      admission.run('background', async () => {
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
          sparesPriority: false,
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

function toTaskPriority(request: Readonly<AdmissionRequest>): TaskPriority {
  return request.isBackground === true ? 'background' : 'foreground';
}
