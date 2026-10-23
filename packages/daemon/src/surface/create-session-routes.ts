import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createSessionRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    list: os.sessions.list.handler((context) => deps.imps.listSessions(context.input.name)),
    kill: os.sessions.kill.handler(async (context) => {
      await deps.imps.killSession(context.input.name, context.input.session);

      return {};
    }),
    logs: os.sessions.logs.handler((context) =>
      deps.imps.listSessionLogs(context.input.name, context.input.session),
    ),
    readLog: os.sessions.readLog.handler((context) => {
      const { name, ...request } = context.input;

      return deps.imps.readSessionLog(name, request);
    }),
    deleteLog: os.sessions.deleteLog.handler(async (context) => {
      const { name, ...target } = context.input;

      return { deleted: await deps.imps.removeSessionLogs(name, target) };
    }),
  };
}
