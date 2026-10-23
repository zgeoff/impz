import type { Scope } from '@impz/api';
import type { ImpdError } from '../platform/errors/impd-error';
import { buildForbiddenError } from '../platform/errors/impd-errors';
import { formatCaller, isCallerAllowed } from '../platform/principal/caller';
import type { Caller } from '../platform/principal/caller';

export function findImpRefusal(
  caller: Readonly<Caller> | undefined,
  scope: Scope,
  name: string,
  action: string,
): ImpdError | null {
  if (caller !== undefined && isCallerAllowed(caller, scope, name)) {
    return null;
  }

  const who = caller === undefined ? 'nobody' : formatCaller(caller);

  return buildForbiddenError(`${who} may not ${action} imp ${name}`);
}
