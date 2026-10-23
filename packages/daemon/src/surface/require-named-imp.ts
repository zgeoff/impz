import type { Scope } from '@impz/api';
import { buildForbiddenError } from '../platform/errors/impd-errors';
import { formatCaller, isCallerAllowed } from '../platform/principal/caller';
import type { Caller } from '../platform/principal/caller';

export function requireNamedImp(
  caller: Readonly<Caller>,
  name: string | undefined,
  scope: Scope = 'read',
): void {
  if (name !== undefined && !isCallerAllowed(caller, scope, name)) {
    throw buildForbiddenError(`${formatCaller(caller)} may not touch imp ${name}`);
  }
}
