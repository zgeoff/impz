import type { Lease, LeaseSummary } from '@impz/api';
import { hasScope } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import type { LeaseRecord } from '../../platform/db/leases';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildForbiddenError, findCallerData } from '../../surface/api-errors';
import { formatCaller, isCallerAllowed } from './caller';
import type { Caller } from './caller';

function canSeeEveryOwner(caller: Readonly<Caller>): boolean {
  return caller.imps === null && hasScope(caller.scope, 'manage');
}

export function requireLeaseHolder(caller: Readonly<Caller>): {
  readonly principal: string;
  readonly display: string;
} {
  if (caller.principal === null) {
    throw buildForbiddenError(
      `${formatCaller(caller)} has no stable identity, so it cannot hold a lease; use a token`,
    );
  }

  return { principal: caller.principal, display: caller.display };
}

export function toApiLease(name: string, lease: Readonly<LeaseRecord>): Lease {
  return {
    name,
    owner: { principal: lease.principal, display: lease.display, label: lease.label },
    until: lease.until,
  };
}

export function toLeaseSummary(
  caller: Readonly<Caller> | null,
  name: string,
  leases: readonly LeaseRecord[],
): LeaseSummary {
  const visible = leases.filter((lease) => isLeaseVisible(caller, lease));

  return {
    leases: visible.map((lease) => toApiLease(name, lease)),
    otherCount: leases.length - visible.length,
  };
}

export function isLeaseVisible(caller: Readonly<Caller> | null, lease: Readonly<LeaseRecord>) {
  return caller !== null && (canSeeEveryOwner(caller) || lease.principal === caller.principal);
}

export function toCallerError(error: unknown, caller: Readonly<Caller> | null): unknown {
  const hidden = findCallerData(error);

  if (hidden === undefined || !(error instanceof ORPCError)) {
    return error;
  }

  const data: unknown = error.data;
  const base = typeof data === 'object' && data !== null ? data : {};

  const shown =
    hidden.kind === 'leases'
      ? toLeaseSummary(caller, hidden.name, hidden.leases)
      : buildVisibleProtected(caller, hidden.imps);

  return new ORPCError(error.code, {
    status: error.status,
    message: error.message,
    data: { ...base, ...shown },
    cause: error.cause,
  });
}

function buildVisibleProtected(
  caller: Readonly<Caller> | null,
  imps: readonly { readonly name: string }[],
) {
  const visible =
    caller === null ? [] : imps.filter((imp) => isCallerAllowed(caller, 'read', imp.name));

  return { protected: visible, protectedHidden: imps.length - visible.length };
}
