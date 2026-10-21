import type { ForbiddenReason, ImpState } from '@impz/api';
import { ORPCError } from '@orpc/server';
import type { LeaseRecord } from '../platform/db/leases';

type ResourceKind =
  | 'imp'
  | 'image'
  | 'checkpoint'
  | 'session'
  | 'service'
  | 'secret'
  | 'grant'
  | 'backup'
  | 'token'
  | 'ssh-key'
  | 'network'
  | 'oauth-client'
  | 'oauth-grant'
  | 'oauth-approval'
  | 'database-copy';

export function buildNotFoundError(kind: ResourceKind, name: string) {
  return new ORPCError('NOT_FOUND', {
    message: `${kind} ${name} not found`,
    data: { kind, name },
  });
}

export function buildConflictError(kind: ResourceKind, name: string, message?: string) {
  return new ORPCError('CONFLICT', {
    message: message ?? `${kind} ${name} already exists`,
    data: { kind, name },
  });
}

export const NOT_BACKED_UP_REASON = 'created with backup off';

export function buildNotBackedUpError(name: string, refusal: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `imp ${name} is left out of backups (${NOT_BACKED_UP_REASON}): ${refusal}`,
  });
}

export function buildForbiddenError(message: string, reason: ForbiddenReason | null = null) {
  return reason === null
    ? new ORPCError('FORBIDDEN', { message })
    : new ORPCError('FORBIDDEN', { message, data: { reason } });
}

export function buildInvalidStateError(
  state: ImpState,
  allowed: readonly ImpState[],
  action: string,
) {
  return new ORPCError('INVALID_STATE', {
    status: 409,
    message: `cannot ${action} an imp that is ${state} (allowed: ${allowed.join(', ')})`,
    data: { state, allowed: [...allowed] },
  });
}

export function buildAgentOutdatedApiError(message: string) {
  return new ORPCError('AGENT_OUTDATED', { status: 409, message });
}

export const MOVING_RETRY_AFTER_S = 30;

export function buildMovingError(name: string) {
  return new ORPCError('MOVING', {
    status: 409,
    message: `${name} is moving between hosts; try again in ${String(MOVING_RETRY_AFTER_S)} s`,
    data: { retryAfterS: MOVING_RETRY_AFTER_S },
  });
}

export function isMovingError(error: unknown): error is ORPCError<'MOVING', unknown> {
  return error instanceof ORPCError && error.code === 'MOVING';
}

export function buildBuilderError(name: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `${name} is an image builder that impd made for one build; only rm reaches it`,
  });
}

export function buildRebootNeededError(name: string) {
  return new ORPCError('PRECONDITION_FAILED', {
    message: `the host needs a reboot: a kernel oops holds the disk of ${name}; reboot the host, then start it`,
  });
}

export function buildStoppingError() {
  return new ORPCError('SERVICE_UNAVAILABLE', { message: 'impd is stopping' });
}

export function isRamBudgetError(error: unknown): boolean {
  return error instanceof ORPCError && error.code === 'RAM_BUDGET_EXCEEDED';
}

export interface ProtectedImp {
  readonly name: string;
  readonly ramMib: number;
  readonly leased: boolean;
  readonly busy: boolean;
}

type CallerData =
  | { readonly kind: 'leases'; readonly name: string; readonly leases: readonly LeaseRecord[] }
  | { readonly kind: 'protected'; readonly imps: readonly ProtectedImp[] };

const callerData = new WeakMap<object, CallerData>();

export function findCallerData(error: unknown): CallerData | undefined {
  return typeof error === 'object' && error !== null ? callerData.get(error) : undefined;
}

interface RamShortfall {
  readonly budgetMib: number;
  readonly usedMib: number;
  readonly requestedMib: number;
  readonly protected: readonly ProtectedImp[];
}

export function buildImpOverBudgetError(budgetMib: number, usedMib: number, memoryMib: number) {
  return buildRamError(
    `the imp's memory, at its max (${String(memoryMib)} MiB), is larger than the whole RAM budget (${String(budgetMib)} MiB)`,
    { budgetMib, usedMib, requestedMib: memoryMib, protected: [] },
  );
}

export function buildRamBudgetError(shortfall: Readonly<RamShortfall>) {
  const used = String(shortfall.usedMib);
  const budget = String(shortfall.budgetMib);
  const requested = String(shortfall.requestedMib);

  return buildRamError(
    `not enough RAM: ${used} of ${budget} MiB in use, ${requested} MiB requested, and no idle imp left to sleep`,
    shortfall,
  );
}

export function buildNeededMib(usedMib: number, requestedMib: number, budgetMib: number): number {
  return Math.max(0, usedMib + requestedMib - budgetMib);
}

function buildRamError(message: string, shortfall: Readonly<RamShortfall>) {
  const error = new ORPCError('RAM_BUDGET_EXCEEDED', {
    status: 503,
    message,
    data: {
      budgetMib: shortfall.budgetMib,
      usedMib: shortfall.usedMib,
      requestedMib: shortfall.requestedMib,
      neededMib: buildNeededMib(shortfall.usedMib, shortfall.requestedMib, shortfall.budgetMib),
      protected: [],
      protectedHidden: shortfall.protected.length,
    },
  });

  callerData.set(error, { kind: 'protected', imps: shortfall.protected });

  return error;
}

export function buildLeasedError(name: string, leases: readonly LeaseRecord[]) {
  const error = new ORPCError('LEASED', {
    status: 409,
    message: `imp ${name} has ${String(leases.length)} lease(s); force ends them`,
    data: { leases: [], otherCount: leases.length },
  });

  callerData.set(error, { kind: 'leases', name, leases });

  return error;
}

export function buildLeaseNotHeldError(name: string, label: string) {
  return new ORPCError('LEASE_NOT_HELD', {
    status: 409,
    message: `the caller holds no live lease ${label} on imp ${name}`,
  });
}

export function isDiskFullError(error: unknown): error is ORPCError<'DISK_FULL', unknown> {
  return error instanceof ORPCError && error.code === 'DISK_FULL';
}
