import { findGrantAuthority } from './auth/access-policy';
import type { RpcImplementer } from './build-implementer';
import type { RouterDeps } from './build-router';

// `grants.*`: which imps a secret reaches
export function buildGrantRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    // a caller for some imps grants the secret its list names, checked
    // again in the grant's transaction: it could be deleted and made
    // again since the access check
    add: os.grants.add.handler(async (context) => {
      const input = context.input;

      await deps.broker.addGrant(
        input.name,
        input.secret,
        findGrantAuthority(context.context.caller, input.secret),
        input.filter,
      );

      return {};
    }),
    delete: os.grants.delete.handler(async (context) => {
      const input = context.input;

      await deps.broker.removeGrant(
        input.name,
        input.secret,
        findGrantAuthority(context.context.caller, input.secret),
      );

      return {};
    }),
    list: os.grants.list.handler((context) => deps.broker.listGrants(context.input.name)),
    details: os.grants.details.handler((context) =>
      deps.broker.listGrantDetails(context.input.name),
    ),
  };
}
