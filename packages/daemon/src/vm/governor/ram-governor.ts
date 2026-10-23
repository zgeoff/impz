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

// KSM can split merged pages after a reading, which no resident counter shows. The KSM headroom
// covers what splits within a tick add, so a reading older than one late tick is read again.
export const READING_MAX_AGE_MS = 2 * ENFORCE_INTERVAL_MS;

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

  // Kept per process by the kernel, so a read is cheap where readRamMib walks every mapped page.
  readonly readResidentMib: (pid: number, apiSocket: string) => Promise<number | null>;

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

interface VmReading {
  readonly pid: number;
  readonly ownedMib: number;
  readonly residentMib: number;
}

interface VmReadings {
  readonly at: number;
  readonly byImp: ReadonlyMap<string, VmReading>;
  readonly headroomMib: number;
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
  let lastReadings: VmReadings | null = null;

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

  const sumEffectiveUsage = (
    awake: readonly AwakeImp[],
    readings: readonly (number | null)[],
    headroomMib: number,
    excludeId: string | null,
  ) => {
    const byImp = new Map<string, number>();

    let usedMib = 0;
    let effectiveMib = headroomMib;

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

    return { awake, byImp, usedMib, effectiveMib, headroomMib };
  };

  const readVmRam = async (imp: AwakeImp) => {
    // A page faulted in between the two reads counts in both, so the bound built on them stays
    // above what the VM owns.
    const residentMib = await deps.readResidentMib(imp.pid, imp.apiSocket);
    const ownedMib = await deps.readRamMib(imp.pid, imp.apiSocket);

    return { ownedMib, residentMib };
  };

  const readEffectiveUsage = async (excludeId: string | null) => {
    const at = now();

    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const readings = await Promise.all(awake.map((imp) => readVmRam(imp)));

    const headroom = deps.readHeadroomMib?.(awake.map((imp) => imp.pid)) ?? Promise.resolve(0);

    const headroomMib = await headroom;

    lastReadings = { at, byImp: collectVmReadings(awake, readings), headroomMib };

    return sumEffectiveUsage(
      awake,
      readings.map((reading) => reading.ownedMib),
      headroomMib,
      excludeId,
    );
  };

  const readBoundedEffectiveMib = async (excludeId: string): Promise<number | null> => {
    const recent = lastReadings;

    if (recent === null || now() - recent.at > READING_MAX_AGE_MS) {
      return null;
    }

    const listed = await deps.listAwake();

    const awake = listed.filter((imp) => imp.id !== excludeId);

    const residents = await Promise.all(
      awake.map((imp) => deps.readResidentMib(imp.pid, imp.apiSocket)),
    );

    const bounds = buildRamBounds(recent, awake, residents);

    return bounds === null
      ? null
      : sumEffectiveUsage(awake, bounds, recent.headroomMib, excludeId).effectiveMib;
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

        const boundMib = await readBoundedEffectiveMib(request.id);

        if (boundMib !== null && boundMib + request.reserveMib <= deps.budgetMib) {
          recordAdmission(request, boundMib);

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

function collectVmReadings(
  awake: readonly AwakeImp[],
  readings: readonly { ownedMib: number | null; residentMib: number | null }[],
): Map<string, VmReading> {
  const byImp = new Map<string, VmReading>();

  for (const [index, imp] of awake.entries()) {
    const reading = readings[index];

    if (reading !== undefined && reading.ownedMib !== null && reading.residentMib !== null) {
      byImp.set(imp.id, {
        pid: imp.pid,
        ownedMib: reading.ownedMib,
        residentMib: reading.residentMib,
      });
    }
  }

  return byImp;
}

function buildRamBounds(
  recent: VmReadings,
  awake: readonly AwakeImp[],
  residents: readonly (number | null)[],
): number[] | null {
  const bounds: number[] = [];

  for (const [index, imp] of awake.entries()) {
    const reading = recent.byImp.get(imp.id);
    const residentMib = residents[index] ?? null;

    if (reading?.pid !== imp.pid || residentMib === null) {
      return null;
    }

    bounds.push(reading.ownedMib + Math.max(0, residentMib - reading.residentMib));
  }

  return bounds;
}
