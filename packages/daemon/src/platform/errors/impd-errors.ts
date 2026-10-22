import type { ForbiddenReason, ImpState } from '@impz/api';
import { ImpdError, isImpdError } from './impd-error';

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
  return new ImpdError('NOT_FOUND', {
    message: `${kind} ${name} not found`,
    data: { kind, name },
  });
}

export function buildConflictError(kind: ResourceKind, name: string, message?: string) {
  return new ImpdError('CONFLICT', {
    message: message ?? `${kind} ${name} already exists`,
    data: { kind, name },
  });
}

export const NOT_BACKED_UP_REASON = 'created with backup off';

export function buildNotBackedUpError(name: string, refusal: string) {
  return new ImpdError('PRECONDITION_FAILED', {
    message: `imp ${name} is left out of backups (${NOT_BACKED_UP_REASON}): ${refusal}`,
  });
}

export function buildForbiddenError(message: string, reason: ForbiddenReason | null = null) {
  return reason === null
    ? new ImpdError('FORBIDDEN', { message })
    : new ImpdError('FORBIDDEN', { message, data: { reason } });
}

export function buildInvalidStateError(
  state: ImpState,
  allowed: readonly ImpState[],
  action: string,
) {
  return new ImpdError('INVALID_STATE', {
    status: 409,
    message: `cannot ${action} an imp that is ${state} (allowed: ${allowed.join(', ')})`,
    data: { state, allowed: [...allowed] },
  });
}

export function buildAgentOutdatedApiError(message: string) {
  return new ImpdError('AGENT_OUTDATED', { status: 409, message });
}

export const MOVING_RETRY_AFTER_S = 30;

export function buildMovingError(name: string) {
  return new ImpdError('MOVING', {
    status: 409,
    message: `${name} is moving between hosts; try again in ${String(MOVING_RETRY_AFTER_S)} s`,
    data: { retryAfterS: MOVING_RETRY_AFTER_S },
  });
}

export function isMovingError(error: unknown): error is ImpdError<'MOVING'> {
  return isImpdError(error, 'MOVING');
}

export function buildBuilderError(name: string) {
  return new ImpdError('PRECONDITION_FAILED', {
    message: `${name} is an image builder that impd made for one build; only rm reaches it`,
  });
}

export function buildRebootNeededError(name: string) {
  return new ImpdError('PRECONDITION_FAILED', {
    message: `the host needs a reboot: a kernel oops holds the disk of ${name}; reboot the host, then start it`,
  });
}

export function buildStoppingError() {
  return new ImpdError('SERVICE_UNAVAILABLE', { message: 'impd is stopping' });
}

export function buildLeaseNotHeldError(name: string, label: string) {
  return new ImpdError('LEASE_NOT_HELD', {
    status: 409,
    message: `the caller holds no live lease ${label} on imp ${name}`,
  });
}
