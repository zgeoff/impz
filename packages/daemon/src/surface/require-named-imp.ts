import type { Scope } from '@impz/api';
import { formatCaller, isCallerAllowed } from '../identity/auth/caller';
import type { Caller } from '../identity/auth/caller';
import { buildForbiddenError } from './api-errors';

export function requireNamedImp(
  caller: Readonly<Caller>,
  name: string | undefined,
  scope: Scope = 'read',
): void {
  if (name !== undefined && !isCallerAllowed(caller, scope, name)) {
    throw buildForbiddenError(`${formatCaller(caller)} may not touch imp ${name}`);
  }
}
