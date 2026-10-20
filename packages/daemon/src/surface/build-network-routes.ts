import { isImpAllowed } from '@impz/api';
import type { RpcImplementer } from './build-implementer';
import type { RouterDeps } from './build-router';

// `networks.*`: the networks imps join
export function buildNetworkRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    // a caller limited to some imps sees those members only
    list: os.networks.list.handler(async (context) => {
      const patterns = context.context.caller.imps;

      const networks = await deps.networks.listNetworks();

      return networks.map((network) => ({
        name: network.name,
        imps: network.imps.filter((name) => isImpAllowed(patterns, name)),
        createdAt: network.createdAt,
      }));
    }),
    create: os.networks.create.handler((context) =>
      deps.networks.createNetwork(context.input.name),
    ),
    delete: os.networks.delete.handler(async (context) => {
      await deps.networks.deleteNetwork(context.input.name);

      return {};
    }),
    join: os.networks.join.handler((context) =>
      deps.networks.joinNetwork(context.input.network, context.input.name),
    ),
    leave: os.networks.leave.handler((context) =>
      deps.networks.leaveNetwork(context.input.network, context.input.name),
    ),
    warnings: os.networks.warnings.handler((context) =>
      deps.networks.readTrustWarnings(context.input.name),
    ),
  };
}
