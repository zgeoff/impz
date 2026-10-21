import { match } from 'ts-pattern';
import { makeLockFreeSleep } from '../../src/imps/imps/lock-free-sleep';
import type { SleepOutcome } from '../../src/imps/imps/lock-free-sleep';
import { buildKeyedMutex } from '../../src/platform/process/keyed-mutex';
import type { RamGovernor, RamGovernorDeps } from '../../src/vm/governor/ram-governor';

interface HostImp {
  awake: boolean;
  rssMib: number;
  lastActiveAt: number;
  held: boolean;
  busy: boolean;

  failsSleep: boolean;

  spareMib: number;
}

export type HostChange =
  | { readonly kind: 'rss'; readonly id: string; readonly mib: number }
  | { readonly kind: 'hold'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'busy'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'failSleep'; readonly id: string; readonly on: boolean }
  | { readonly kind: 'spare'; readonly id: string; readonly mib: number }
  | { readonly kind: 'touch'; readonly id: string }
  | { readonly kind: 'stop'; readonly id: string }
  | { readonly kind: 'tick'; readonly durationMs: number };

interface StubGovernedHostOptions {
  readonly budgetMib: number;
  readonly ids: readonly string[];

  readonly awake: readonly {
    readonly id: string;
    readonly rssMib: number;
    readonly failsSleep?: boolean;
  }[];
}

const HELD_FOREVER = Number.MAX_SAFE_INTEGER;

export interface RoomLeft {
  readonly overMib: number;
  readonly eligibleAwake: number;
}

export function createStubGovernedHost(options: Readonly<StubGovernedHostOptions>) {
  const imps = new Map<string, HostImp>(
    options.ids.map((id) => [
      id,
      {
        awake: false,
        rssMib: 0,
        lastActiveAt: 0,
        held: false,
        busy: false,
        failsSleep: false,
        spareMib: 0,
      },
    ]),
  );

  for (const [index, imp] of options.awake.entries()) {
    imps.set(imp.id, {
      awake: true,
      rssMib: imp.rssMib,
      lastActiveAt: index,
      held: false,
      busy: false,
      failsSleep: imp.failsSleep ?? false,
      spareMib: 0,
    });
  }

  const clock = { now: 1_000_000 };
  const pacer: { pace: () => Promise<void> } = { pace: () => Promise.resolve() };

  const sleepCalls: {
    readonly id: string;
    readonly eligible: boolean;
    readonly outcome: SleepOutcome;
  }[] = [];

  const refusals = new Map<string, Exclude<SleepOutcome, 'slept'>>();

  const mutex = buildKeyedMutex();

  const getImp = (id: string): HostImp => {
    const imp = imps.get(id);

    if (imp === undefined) {
      throw new Error(`no imp ${id}`);
    }

    return imp;
  };

  const trySleepImp = makeLockFreeSleep<string>(
    (id, action) => mutex.tryRunExclusive(id, () => action(id)),
    async (id): Promise<SleepOutcome> => {
      await pacer.pace();

      const imp = getImp(id);
      const eligible = imp.awake && !imp.held && !imp.busy;
      const failedOutcome = imp.failsSleep ? 'failed' : 'slept';
      const outcome: SleepOutcome = eligible ? (refusals.get(id) ?? failedOutcome) : 'skipped';

      sleepCalls.push({ id, eligible, outcome });

      if (outcome === 'slept') {
        imp.awake = false;
      }

      return outcome;
    },
  );

  const deps = {
    budgetMib: options.budgetMib,
    listAwake: async (): ReturnType<RamGovernorDeps['listAwake']> => {
      await pacer.pace();

      return [...imps]
        .filter(([, imp]) => imp.awake)
        .map(([id, imp]) => ({
          id,
          name: id,
          pid: options.ids.indexOf(id) + 1,

          apiSocket: id,
          lastActiveAt: imp.lastActiveAt,
          holdUntil: imp.held ? HELD_FOREVER : null,
        }));
    },
    readRamMib: (_pid: number, id: string): Promise<number | null> => {
      const ramMib = imps.get(id)?.awake === true ? getImp(id).rssMib : null;

      return Promise.resolve(ramMib);
    },
    isBusy: (id: string): boolean => getImp(id).busy,
    trySleepImp,

    reclaim: async (excludeId: string | null): Promise<number> => {
      await pacer.pace();

      const givers = [...imps].filter(([id, imp]) => imp.awake && !imp.busy && id !== excludeId);

      return givers.reduce((freedMib, [, imp]) => {
        const mib = Math.min(imp.spareMib, imp.rssMib);

        imp.rssMib -= mib;
        imp.spareMib = 0;

        return freedMib + mib;
      }, 0);
    },
    now: (): number => clock.now,
  } satisfies Omit<RamGovernorDeps, 'log'>;

  return {
    imps,
    pacer,
    sleepCalls,
    deps,
    findImp: getImp,

    markAdmitted: (id: string): void => {
      Object.assign(getImp(id), { awake: true, rssMib: 0, lastActiveAt: clock.now });
    },

    readReservation: async (
      id: string,
      governor: Pick<RamGovernor, 'readUsage'>,
    ): Promise<number> => {
      const imp = getImp(id);

      if (imp.awake) {
        return 0;
      }

      const asleep = await governor.readUsage();

      Object.assign(imp, { awake: true, rssMib: 1_000_000 });

      const measured = await governor.readUsage();

      Object.assign(imp, { awake: false, rssMib: 0 });

      return asleep.reservedMib - measured.reservedMib;
    },

    getRoomLeft: (): RoomLeft => {
      const awake = [...imps].filter(([, imp]) => imp.awake);
      const usedMib = awake.reduce((sum, [, imp]) => sum + imp.rssMib, 0);

      const eligible = awake.filter(
        ([id, imp]) => !imp.held && !imp.busy && !imp.failsSleep && !refusals.has(id),
      );

      return { overMib: usedMib - options.budgetMib, eligibleAwake: eligible.length };
    },

    refuseSleep: (id: string, outcome: Exclude<SleepOutcome, 'slept'>): void => {
      refusals.set(id, outcome);
    },

    applyChange: (change: HostChange, governor: Pick<RamGovernor, 'release'>): void => {
      if (change.kind === 'tick') {
        clock.now += change.durationMs;

        return;
      }

      const imp = getImp(change.id);

      match(change)
        .with({ kind: 'rss' }, (rss) => {
          imp.rssMib = rss.mib;
        })
        .with({ kind: 'hold' }, (hold) => {
          imp.held = hold.on;
        })
        .with({ kind: 'busy' }, (busy) => {
          imp.busy = busy.on;
        })
        .with({ kind: 'failSleep' }, (failSleep) => {
          imp.failsSleep = failSleep.on;
        })
        .with({ kind: 'spare' }, (spare) => {
          imp.spareMib = spare.mib;
        })
        .with({ kind: 'touch' }, () => {
          imp.lastActiveAt = clock.now;
        })
        .with({ kind: 'stop' }, (stop) => {
          imp.awake = false;

          governor.release(stop.id);
        })
        .exhaustive();
    },
  };
}
