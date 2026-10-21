import { listApiCalls } from '../platform/db/api-audit';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';
import { requireNamedImp } from './require-named-imp';

const AUDIT_LIMIT = 100;

export function buildAuditRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    list: os.audit.list.handler((context) => {
      const caller = context.context.caller;

      requireNamedImp(caller, context.input.name);

      return deps.broker.listAudit(
        context.input.name ?? null,
        context.input.limit ?? AUDIT_LIMIT,
        caller.imps,
      );
    }),
    refused: os.audit.refused.handler((context) => {
      const caller = context.context.caller;

      requireNamedImp(caller, context.input.name);

      return deps.broker.listRefused(
        context.input.name ?? null,
        context.input.limit ?? AUDIT_LIMIT,
        caller.imps,
      );
    }),
    calls: os.audit.calls.handler((context) => {
      const caller = context.context.caller;

      requireNamedImp(caller, context.input.name);

      return listApiCalls(
        deps.db,
        context.input.name ?? null,
        context.input.limit ?? AUDIT_LIMIT,
        caller.imps,
      );
    }),
  };
}
