import { hasScope } from '@impz/api';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

const DEFAULT_LOG_LINES = 100;

export function createServiceRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    list: os.services.list.handler((context) => deps.imps.listServices(context.input.name)),
    add: os.services.add.handler(async (context) => {
      const input = context.input;

      await deps.imps.addService(input.name, input.service, {
        canManage: hasScope(context.context.caller.scope, 'manage'),
        replace: input.replace ?? false,
      });

      return {};
    }),
    remove: os.services.remove.handler(async (context) => {
      const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

      await deps.imps.removeService(context.input.name, context.input.service, rights);

      return {};
    }),
    restart: os.services.restart.handler(async (context) => {
      const rights = { canManage: hasScope(context.context.caller.scope, 'manage') };

      await deps.imps.restartService(context.input.name, context.input.service, rights);

      return {};
    }),
    logs: os.services.logs.handler((context) =>
      deps.imps.openServiceLogs(context.input.name, {
        service: context.input.service,
        lines: context.input.lines ?? DEFAULT_LOG_LINES,
        follow: context.input.follow ?? false,
      }),
    ),
  };
}
