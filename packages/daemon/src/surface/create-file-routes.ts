import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createFileRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    write: os.files.write.handler((context) =>
      deps.imps.writeFile(context.input.name, context.input.path, context.input.content),
    ),
    remove: os.files.remove.handler((context) =>
      deps.imps.removeFile(context.input.name, context.input.path),
    ),
  };
}
