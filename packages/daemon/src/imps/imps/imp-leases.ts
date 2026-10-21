import type { Imp } from '@impz/api';
import { listImps, updateImpActivity } from '../../platform/db/imps';
import {
  HOLD_LABEL,
  LEGACY_PRINCIPAL,
  isBlockingLease,
  listLeases,
  removeLeases,
  writeLease,
} from '../../platform/db/leases';
import type { LeaseRecord } from '../../platform/db/leases';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildLeaseNotHeldError, buildLeasedError } from '../../surface/api-errors';
import type { ImpClock, ImpHost } from './imp-context';
import { toLockedImp } from './imp-lock';
import type { ImpLock, LockedImp } from './imp-lock';
import type { ImpPresenter } from './imp-presenter';
import type { ImpVmOps } from './imp-vm-ops';

interface LeaseHolder {
  readonly principal: string;
  readonly display: string;
}

interface NamedLease {
  readonly name: string;
  readonly lease: LeaseRecord;
}

export interface ImpLeases {
  readonly acquireLease: (
    name: string,
    holder: LeaseHolder,
    label: string,
    ttlSeconds: number,
  ) => Promise<NamedLease>;

  readonly renewLease: (
    name: string,
    holder: LeaseHolder,
    label: string,
    ttlSeconds: number,
  ) => Promise<NamedLease>;

  readonly releaseLease: (name: string, holder: LeaseHolder, label: string) => Promise<boolean>;

  readonly listLeases: () => Promise<NamedLease[]>;

  readonly readLeases: (impIds: readonly string[]) => Promise<Map<string, LeaseRecord[]>>;

  readonly holdImp: (name: string, seconds: number, holder: LeaseHolder) => Promise<Imp>;

  readonly requireUnleased: (imp: LockedImp, force: boolean) => Promise<void>;

  readonly endForcedLeases: (imp: LockedImp) => Promise<LockedImp>;
}

interface ImpLeaseParts {
  readonly context: ImpHost & ImpClock;
  readonly lock: ImpLock;
  readonly ops: ImpVmOps;
  readonly presenter: ImpPresenter;
}

export function createImpLeases(parts: ImpLeaseParts): ImpLeases {
  const context = parts.context;
  const lock = parts.lock;
  const ops = parts.ops;
  const presenter = parts.presenter;

  const readLease = async (impId: string, principal: string, label: string, at: number) => {
    const leases = await listLeases(context.db, at, [impId]);

    return leases.find((lease) => lease.principal === principal && lease.label === label);
  };

  return {
    acquireLease: (name, holder, label, ttlSeconds) =>
      lock.withImp(name, async (imp) => {
        await updateImpActivity(context.db, imp.id, new Date());

        await ops.requireRunningImp(imp);

        const at = context.now();

        const live = await readLease(imp.id, holder.principal, label, at);

        const lease: LeaseRecord = {
          impId: imp.id,
          principal: holder.principal,
          label,
          display: holder.display,
          until: buildLeaseEnd(live, at, ttlSeconds),
          createdAt: live?.createdAt ?? new Date(at),
        };

        await writeLease(context.db, lease, { at, reason: 'held' });

        return { name: imp.name, lease };
      }),

    renewLease: (name, holder, label, ttlSeconds) =>
      lock.withImp(name, async (imp) => {
        const at = context.now();

        const live = await readLease(imp.id, holder.principal, label, at);

        if (live === undefined) {
          throw buildLeaseNotHeldError(imp.name, label);
        }

        const lease: LeaseRecord = {
          ...live,
          display: holder.display,
          until: buildLeaseEnd(live, at, ttlSeconds),
        };

        await writeLease(context.db, lease, { at, reason: null });

        return { name: imp.name, lease };
      }),

    releaseLease: (name, holder, label) =>
      lock.withImp(name, async (imp) => {
        const released = await removeLeases(
          context.db,
          imp.id,
          [{ principal: holder.principal, label }],
          { at: context.now(), reason: 'held' },
        );

        return released.removed > 0;
      }),

    listLeases: async () => {
      const at = context.now();

      const [imps, leases] = await Promise.all([listImps(context.db), listLeases(context.db, at)]);

      const names = new Map(imps.map((imp) => [imp.id, imp.name]));

      return leases.flatMap((lease) => {
        const name = names.get(lease.impId);

        return name === undefined ? [] : [{ name, lease }];
      });
    },

    readLeases: async (impIds) => {
      const leases = await listLeases(context.db, context.now(), impIds);

      return Map.groupBy(leases, (lease) => lease.impId);
    },

    holdImp: (name, seconds, holder) =>
      lock.withImp(name, async (imp) => {
        const at = context.now();

        if (seconds === 0) {
          const released = await removeLeases(
            context.db,
            imp.id,
            [
              { principal: holder.principal, label: HOLD_LABEL },
              { principal: LEGACY_PRINCIPAL, label: HOLD_LABEL },
            ],
            { at, reason: 'held', isEmittedWhenNone: true },
          );

          return presenter.readApi(toLockedImp(imp, released.imp));
        }

        const live = await readLease(imp.id, holder.principal, HOLD_LABEL, at);

        const updated = await writeLease(
          context.db,
          {
            impId: imp.id,
            principal: holder.principal,
            label: HOLD_LABEL,
            display: holder.display,
            until: new Date(at + seconds * 1000),
            createdAt: live?.createdAt ?? new Date(at),
          },
          { at, reason: 'held' },
        );

        await updateImpActivity(context.db, imp.id, new Date());

        const running = await ops.requireRunningImp(toLockedImp(imp, updated));

        return presenter.readApi(running);
      }),

    requireUnleased: async (imp, force) => {
      if (force) {
        return;
      }

      const leases = await listLeases(context.db, context.now(), [imp.id]);

      const blocking = leases.filter((lease) => isBlockingLease(lease));

      if (blocking.length > 0) {
        throw buildLeasedError(imp.name, blocking);
      }
    },

    endForcedLeases: async (imp) => {
      const released = await removeLeases(context.db, imp.id, 'blocking', {
        at: context.now(),
        reason: 'released',
      });

      if (released.removed > 0) {
        context.log(
          `impd: ${imp.name}: a forced sleep or stop ended ${String(released.removed)} lease(s)`,
        );
      }

      return toLockedImp(imp, released.imp);
    },
  };
}

function buildLeaseEnd(
  lease: LeaseRecord | undefined,
  at: number,
  ttlSeconds: number,
): Date | null {
  const until = at + ttlSeconds * 1000;

  if (lease === undefined) {
    return new Date(until);
  }

  return lease.until === null ? null : new Date(Math.max(lease.until.getTime(), until));
}
