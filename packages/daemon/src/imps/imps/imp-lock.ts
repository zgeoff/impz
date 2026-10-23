import { readImpById, readImpByName } from '../../platform/db/imps';
import type { ImpRecord } from '../../platform/db/imps';
import {
  buildMovingError,
  buildNotFoundError,
  isMovingError,
} from '../../platform/errors/impd-errors';
import { buildKeyedMutex } from '../../platform/process/keyed-mutex';
import type { TryResult } from '../../platform/process/keyed-mutex';
import { withImpLogContext } from '../../platform/process/with-imp-log-context';
import type { ImpDisk, ImpHost, ImpMemory, ImpVms } from './imp-context';
import { checkLiveness } from './imp-liveness';

const LOCKED = Symbol('locked');
const MOVING: unique symbol = Symbol('moving');

interface LockHold {
  readonly impId: string;
}

const endedHolds = new WeakSet<LockHold>();

export type LockedImp = ImpRecord & { readonly [LOCKED]: LockHold };

interface WithImpOptions {
  readonly isMove?: boolean;
}

export interface ImpLock {
  readonly findImp: (name: string) => Promise<ImpRecord>;

  readonly withImp: <T>(
    name: string,
    action: (imp: LockedImp) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<T>;

  readonly withImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<T>;

  readonly withNewImp: <T>(
    id: string,
    insert: () => Promise<ImpRecord>,
    action: (imp: LockedImp) => Promise<T>,
  ) => Promise<T>;

  readonly tryWithImpId: <T>(
    id: string,
    action: (imp: LockedImp | undefined) => Promise<T>,
    options?: WithImpOptions,
  ) => Promise<TryResult<T>>;

  readonly isLocked: (id: string) => boolean;

  readonly countQueued: (id: string) => number;

  readonly waitForAll: () => Promise<void>;
}

export function isLockedImp(imp: ImpRecord & { readonly [LOCKED]?: LockHold }): imp is LockedImp {
  const hold = imp[LOCKED];

  return hold !== undefined && !endedHolds.has(hold);
}

export function toLockedImp(held: LockedImp, next: ImpRecord): LockedImp {
  if (next.id !== held.id) {
    throw new Error(`imp ${next.id} is not the locked imp ${held.id}`);
  }

  return { ...next, [LOCKED]: held[LOCKED] };
}

export function createImpLock(context: ImpHost & ImpVms & ImpMemory & ImpDisk): ImpLock {
  const mutex = buildKeyedMutex();
  const runJoined = <T>(task: () => Promise<T>) => context.storageGate.join(task);

  const readLocked = async (
    id: string,
    options: WithImpOptions,
  ): Promise<LockedImp | undefined> => {
    const imp = await readImpById(context.db, id);

    if (imp === undefined) {
      return undefined;
    }

    const live = await checkLiveness(context, imp, true);

    if (live.moveState !== null && options.isMove !== true) {
      throw buildMovingError(live.name);
    }

    return { ...live, [LOCKED]: { impId: id } };
  };

  const readImp = async (name: string): Promise<ImpRecord> => {
    const imp = await readImpByName(context.db, name);

    if (imp === undefined) {
      throw buildNotFoundError('imp', name);
    }

    return checkLiveness(context, imp, !mutex.isLocked(imp.id));
  };

  return {
    findImp: readImp,
    withImp: async (name, action, options = {}) => {
      const found = await readImp(name);

      return mutex.runExclusive(found.id, () =>
        runJoined(async () => {
          const imp = await readLocked(found.id, options);

          if (imp === undefined) {
            throw buildNotFoundError('imp', name);
          }

          return runAbout(imp, action);
        }),
      );
    },
    withImpId: (id, action, options = {}) =>
      mutex.runExclusive(id, () =>
        runJoined(async () => {
          const imp = await readLocked(id, options);

          return runAbout(imp, action);
        }),
      ),
    withNewImp: (id, insert, action) =>
      mutex.runExclusive(id, () =>
        runJoined(async () => {
          const imp = await insert();

          return runAbout({ ...imp, [LOCKED]: { impId: imp.id } }, action);
        }),
      ),

    tryWithImpId: async (id, action, options = {}) => {
      const result = await mutex.tryRunExclusive(id, () =>
        runJoined(async () => {
          const imp = await readLocked(id, options).catch((error: unknown): typeof MOVING => {
            if (isMovingError(error)) {
              return MOVING;
            }

            throw error;
          });

          return imp === MOVING ? MOVING : runAbout(imp, action);
        }),
      );

      if (!result.ran) {
        return result;
      }

      return result.value === MOVING ? { ran: false } : { ran: true, value: result.value };
    },
    isLocked: (id) => mutex.isLocked(id),
    countQueued: (id) => mutex.countQueued(id),
    waitForAll: () => mutex.waitForAll(),
  };
}

async function runAbout<I extends LockedImp | undefined, T>(
  imp: I,
  action: (imp: I) => Promise<T>,
): Promise<T> {
  if (imp === undefined) {
    return action(imp);
  }

  try {
    return await withImpLogContext(imp.name, () => action(imp));
  } finally {
    endedHolds.add(imp[LOCKED]);
  }
}
