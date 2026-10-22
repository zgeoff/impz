import { callerContract } from '@impz/api';
import { mapEventIterator } from '@orpc/client';
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
import { buildBuilderError, buildForbiddenError } from '../platform/errors/impd-errors';
import type { RouterDeps } from './create-router';
import { toORPCError } from './to-orpc-error';

export interface RpcContext {
  readonly caller: Caller;
  readonly ends: AbortSignal | null;
}

export interface AuditDetail {
  value: string | null;
}

export type RpcImplementer = ReturnType<typeof createImplementer>;

export function createImplementer(deps: RouterDeps) {
  // Never cached: a secret's name can come to mean another secret than the
  // one a token was given.
  const readGeneration = async (name: string): Promise<string | null> => {
    const secret = await readSecret(deps.db, name);

    return secret?.generation ?? null;
  };

  return implement(callerContract)
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

      const auditDetail: AuditDetail = { value: null };
      const startedAt = deps.now();

      const buildCall = (output: unknown) => ({
        procedure,
        actor: caller,
        impName: findImpName(procedure, input, output),
        startedAt,
        detail: auditDetail.value,
      });

      const toApiError = (error: unknown) => toORPCError(toCallerError(error, caller));

      if (!isAuditedProcedure(procedure)) {
        try {
          await requireAccess();
        } catch (error) {
          if (isRefusalAudited(procedure)) {
            deps.audit.record(buildCall(null), error);
          }

          throw toApiError(error);
        }

        try {
          const result = await options.next({ context: { auditDetail } });

          return withStreamErrors(result, toApiError);
        } catch (error) {
          throw toApiError(error);
        }
      }

      try {
        await requireAccess();

        const result = await options.next({ context: { auditDetail } });

        deps.audit.record(buildCall(result.output), null);

        return withStreamErrors(result, toApiError);
      } catch (error) {
        deps.audit.record(buildCall(null), error);
        throw toApiError(error);
      }
    });
}

// a stream's error comes after the procedure returned, outside the catch above
function withStreamErrors<T extends { readonly output: unknown }>(
  result: T,
  toApiError: (error: unknown) => unknown,
): T {
  if (!isAsyncIterator(result.output)) {
    return result;
  }

  const output = mapEventIterator(result.output, {
    value: (value) => Promise.resolve(value),
    error: (failure) => Promise.resolve(toApiError(failure)),
  });

  return { ...result, output };
}

function isAsyncIterator(value: unknown): value is AsyncIterator<unknown> {
  return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
