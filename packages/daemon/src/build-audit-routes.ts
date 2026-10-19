import type { RpcImplementer } from './build-implementer';
import type { RouterDeps } from './build-router';
import { listApiCalls } from './db/api-audit';
import { requireNamedImp } from './require-named-imp';

// audit rows `audit.list` gives when the caller names no limit
const AUDIT_LIMIT = 100;

// `audit.*`: the broker's and the API's audit rows
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
