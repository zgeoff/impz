import { hasScope } from '@impz/api';
import { formatCaller, isCallerAllowed } from '../../identity/auth/caller';
import type { Caller } from '../../identity/auth/caller';
import { toCallerError } from '../../identity/auth/caller-view';
import type { ExecBackend } from '../../imps/exec/exec-session';
import { buildForbiddenError } from '../../platform/errors/impd-errors';

// Each start checks the scope, so a client reads FORBIDDEN on the socket
// instead of a refused upgrade it cannot read.
export interface ExecGrant {
  readonly caller: Caller;
  readonly name: string | null;
}

export function buildGrantedBackend(
  backend: ExecBackend,
  grant: Readonly<ExecGrant> | undefined,
): ExecBackend {
  const checkGrant = (name: string): Error | null => {
    if (grant === undefined) {
      return buildForbiddenError('the exec socket was not authorized');
    }

    if (grant.name !== null && name !== grant.name) {
      return buildForbiddenError(`the exec ticket is for imp ${grant.name}`);
    }

    if (!isCallerAllowed(grant.caller, 'exec', name)) {
      return buildForbiddenError(`${formatCaller(grant.caller)} may not exec in imp ${name}`);
    }

    return null;
  };

  const checkOuter = (): Error | null => {
    if (grant === undefined || grant.name !== null) {
      return buildForbiddenError('an exec ticket cannot run an exec in the agent');
    }

    if (grant.caller.imps !== null || !hasScope(grant.caller.scope, 'manage')) {
      return buildForbiddenError(
        `${formatCaller(grant.caller)} needs host-wide scope manage to exec in the agent`,
      );
    }

    return null;
  };

  const openAsCaller = async <T>(opening: Promise<T>): Promise<T> => {
    try {
      return await opening;
    } catch (error) {
      throw toCallerError(error, grant?.caller ?? null);
    }
  };

  return {
    // A tool runs as root, which `exec` scope must not reach, so it needs
    // `manage`, and a ticket never starts one.
    openExec: (name, request, feature) => {
      const refused = checkGrant(name) ?? (request.outer === true ? checkOuter() : null);

      if (refused !== null) {
        return Promise.reject(refused);
      }

      if (feature === undefined || request.outer === true) {
        return openAsCaller(backend.openExec(name, request, feature));
      }

      if (grant?.name !== null) {
        return Promise.reject(buildForbiddenError('an exec ticket cannot run a tool'));
      }

      if (!isCallerAllowed(grant.caller, 'manage', name)) {
        return Promise.reject(
          buildForbiddenError(`${formatCaller(grant.caller)} needs scope manage to copy as root`),
        );
      }

      return openAsCaller(backend.openExec(name, request, feature));
    },
    openAttach: (name, request) => {
      const refused = checkGrant(name);

      return refused === null
        ? openAsCaller(backend.openAttach(name, request))
        : Promise.reject(refused);
    },
    recordActivity: (name) => backend.recordActivity(name),
  };
}
