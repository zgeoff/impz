import type { RpcImplementer } from './build-implementer';
import type { RouterDeps } from './build-router';

// `oauth.*`: the public MCP route's clients, grants and approvals
export function buildOAuthRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    clients: {
      list: os.oauth.clients.list.handler(() => deps.oauth.listClients()),
      add: os.oauth.clients.add.handler((context) =>
        deps.oauth.addClient(context.input.name, context.input.redirectUris),
      ),
      update: os.oauth.clients.update.handler((context) =>
        deps.oauth.updateClient(context.input.name, context.input.redirectUris),
      ),
      delete: os.oauth.clients.delete.handler(async (context) => {
        await deps.oauth.removeClient(context.input.name);

        return {};
      }),
    },
    grants: {
      list: os.oauth.grants.list.handler(() => deps.oauth.listGrants()),
      delete: os.oauth.grants.delete.handler(async (context) => {
        await deps.oauth.removeGrant(context.input.id);

        return {};
      }),
    },
    approvals: {
      get: os.oauth.approvals.get.handler((context) =>
        deps.oauth.readApproval(context.input.code, context.context.caller),
      ),
      approve: os.oauth.approvals.approve.handler((context) => {
        deps.oauth.approve(
          context.input.code,
          context.context.caller,
          context.input.scope,
          context.input.imps,
        );

        return {};
      }),
    },
  };
}
