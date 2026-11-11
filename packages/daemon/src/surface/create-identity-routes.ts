import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createIdentityRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    jwks: os.identity.jwks.handler(() => deps.broker.readIdentityDocument()),
    stageKey: os.identity.stageKey.handler((context) =>
      deps.broker.stageIdentityKey(context.input.at),
    ),
  };
}
