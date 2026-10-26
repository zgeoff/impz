import { isImpAllowed } from '@impz/api';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createSecretRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    add: os.secrets.add.handler((context) => deps.broker.addSecret(context.input)),

    list: os.secrets.list.handler(async (context) => {
      const patterns = context.context.caller.imps;

      const secrets = await deps.broker.listSecrets();

      return secrets.map((secret) => ({
        name: secret.name,
        kind: secret.kind,
        rules: secret.rules,
        env: secret.env,
        imps: secret.imps.filter((name) => isImpAllowed(patterns, name)),
        createdAt: secret.createdAt,
        oauth: secret.oauth,
      }));
    }),
    refresh: os.secrets.refresh.handler((context) => deps.broker.refreshSecret(context.input.name)),
    delete: os.secrets.delete.handler(async (context) => {
      await deps.broker.deleteSecret(context.input.name);

      return {};
    }),
  };
}
