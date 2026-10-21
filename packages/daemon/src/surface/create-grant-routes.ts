import { findGrantAuthority } from '../identity/auth/access-policy';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createGrantRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
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
