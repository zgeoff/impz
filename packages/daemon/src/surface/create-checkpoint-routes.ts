import type { CallerImps } from './build-caller-imps';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createCheckpointRoutes(os: RpcImplementer, deps: RouterDeps, views: CallerImps) {
  return {
    create: os.checkpoints.create.handler((context) =>
      deps.checkpoints.createCheckpoint(context.input.name, context.input.label),
    ),
    list: os.checkpoints.list.handler((context) =>
      deps.checkpoints.listCheckpoints(context.input.name),
    ),
    restore: os.checkpoints.restore.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.checkpoints.restoreCheckpoint(context.input.name, context.input.checkpoint),
      ),
    ),
    delete: os.checkpoints.delete.handler(async (context) => {
      await deps.checkpoints.removeCheckpoint(context.input.name, context.input.checkpoint);

      return {};
    }),
  };
}
