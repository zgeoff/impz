import type { Scope } from '@impz/api';
import { buildForbiddenError } from './api-errors';
import { formatCaller, isCallerAllowed } from './auth/caller';
import type { Caller } from './auth/caller';

// an audit or lease list may name one imp, which must be the caller's
export function requireNamedImp(
  caller: Readonly<Caller>,
  name: string | undefined,
  scope: Scope = 'read',
): void {
  if (name !== undefined && !isCallerAllowed(caller, scope, name)) {
    throw buildForbiddenError(`${formatCaller(caller)} may not touch imp ${name}`);
  }
}
