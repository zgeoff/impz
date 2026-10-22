import { EVENT_VERSION } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import type { LockFreeSleep } from '../../imps/imps/lock-free-sleep';
import type { EventBus } from '../../platform/events/event-bus';
import { createSemaphore } from '../../platform/process/semaphore';
import { pickSleepVictims } from './pick-sleep-victims';
import { buildImpOverBudgetError, buildNeededMib, buildRamBudgetError } from './ram-budget-error';
import type { ProtectedImp } from './ram-budget-error';

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
}

interface AdmissionRequest {
  readonly id: string;
  readonly name: string | null;
  readonly reserveMib: number;
  readonly memoryMib: number;
  readonly maySleepImps?: boolean;
}

export interface GrowRequest {
  readonly id: string;
  readonly name: string;

  // The plug plus the host kernel's struct pages for it.
  readonly mib: number;
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

export interface RamAdmission {
  readonly admit: (request: AdmissionRequest) => Promise<void>;
  readonly release: (id: string) => void;
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

  // Writes split pages that KSM merged faster than a tick, so a share of what KSM saves stays free.
  readonly readHeadroomMib?: (pids: readonly number[]) => Promise<number>;
  readonly isBusy: (id: string) => boolean;
  readonly trySleepImp: LockFreeSleep;
  readonly readDiskFullError?: () => Error | null;
  readonly log: (message: string) => void;
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

  const readEffectiveUsage = async (excludeId: string | null) => {
    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const byImp = new Map<string, number>();

    let usedMib = 0;
    let effectiveMib = 0;

    const readings = await Promise.all(awake.map((imp) => deps.readRamMib(imp.pid, imp.apiSocket)));

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
          deps.log(`impd: governor: unplugged ${String(freedMib)} MiB from idle imps (${reason})`);
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

        reservations.set(request.id, {
          mib: request.reserveMib,
          until: now() + RESERVATION_TTL_MS,
        });

        emitAdmission(request, 'admitted', room.effectiveMib);
      }),

    release: (id) => {
      reservations.delete(id);
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
          deps.log(`impd: governor: slept ${String(room.slept)}, RAM still ${over}`);

          stuckOver = true;
        } else if (!stuckOver) {
          deps.log(`impd: governor: RAM ${over} and no idle imp left to sleep`);

          stuckOver = true;
        }
      }),
  };
}
