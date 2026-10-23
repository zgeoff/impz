import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createExecRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    ticket: os.exec.ticket.handler(async (context) => {
      await deps.imps.readImp(context.input.name);

      return deps.execTickets.issue(context.input.name, context.context.caller);
    }),
  };
}
