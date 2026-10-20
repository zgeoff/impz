import { impContract } from '@impz/api';
import { implement } from '@orpc/server';
import {
  checkAccess,
  findAccess,
  isAuditedProcedure,
  isRefusalAudited,
} from '../identity/auth/access-policy';
import { readChangedImps } from '../identity/auth/builder-calls';
import type { Caller } from '../identity/auth/caller';
import { toCallerError } from '../identity/auth/caller-view';
import { findImpName } from '../platform/audit/api-audit';
import { readImpByName } from '../platform/db/imps';
import { readSecret } from '../platform/db/secrets';
import { buildBuilderError, buildForbiddenError } from './api-errors';
import type { RouterDeps } from './create-router';

// what each call gets from create-app: who made it, and a signal that aborts
// when what it authenticated with ends (a logout, a removed token); null
// for nothing that can end
export interface RpcContext {
  readonly caller: Caller;
  readonly ends: AbortSignal | null;
}

// what a handler resolved that the call's audit row keeps
export interface AuditDetail {
  value: string | null;
}

// the implementer every procedure is built on, which a topic's routes take
// (create-system-routes.ts, create-token-routes.ts)
export type RpcImplementer = ReturnType<typeof createImplementer>;

export function createImplementer(deps: RouterDeps) {
  // read at each grant or revoke, never cached: the secret by a name can be
  // another one than a token was given
  const readGeneration = async (name: string): Promise<string | null> => {
    const secret = await readSecret(deps.db, name);

    return secret?.generation ?? null;
  };

  // every call is checked against its access rule (auth/access-policy.ts);
  // every call that changes something, refused or not, leaves an audit row
  // after its answer
  return implement(impContract)
    .$context<RpcContext>()
    .use(async (options, input) => {
      const procedure = options.path.join('.');
      const caller = options.context.caller;

      const requireAccess = async (): Promise<void> => {
        const access = findAccess(procedure);

        const refusal = await checkAccess(access, caller, input, readGeneration);

        if (refusal !== null) {
          throw buildForbiddenError(refusal.message, refusal.reason);
        }

        for (const name of readChangedImps(procedure, access, input)) {
          const imp = await readImpByName(deps.db, name);

          if (imp?.kind === 'builder') {
            throw buildBuilderError(name);
          }
        }
      };

      // what a handler resolved for the audit row, such as an add's pull
      const auditDetail: AuditDetail = { value: null };
      const startedAt = deps.now();

      const buildCall = (output: unknown) => ({
        procedure,
        actor: caller,
        impName: findImpName(procedure, input, output),
        startedAt,
        detail: auditDetail.value,
      });

      if (!isAuditedProcedure(procedure)) {
        try {
          await requireAccess();
        } catch (error) {
          if (isRefusalAudited(procedure)) {
            deps.audit.record(buildCall(null), error);
          }

          throw toCallerError(error, caller);
        }

        try {
          return await options.next({ context: { auditDetail } });
        } catch (error) {
          throw toCallerError(error, caller);
        }
      }

      try {
        await requireAccess();

        const result = await options.next({ context: { auditDetail } });

        deps.audit.record(buildCall(result.output), null);

        return result;
      } catch (error) {
        deps.audit.record(buildCall(null), error);

        // a refusal names only the leases and imps the caller may see
        throw toCallerError(error, caller);
      }
    });
}
