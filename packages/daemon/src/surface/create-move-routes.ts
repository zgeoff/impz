import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createMoveRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    prepare: os.moves.prepare.handler((context) =>
      deps.moves.prepare(context.input.name, {
        stop: context.input.stop === true,
        force: context.input.force === true,
        targetStorage: context.input.targetStorage ?? 'xfs',
        target: context.input.target ?? null,
      }),
    ),
    facts: os.moves.facts.handler(() => deps.moves.readFacts()),
    receive: os.moves.receive.handler((context) =>
      deps.moves.issueTicket(context.input.name, context.input.bytes, context.input.warm),
    ),
    send: os.moves.send.handler((context) =>
      deps.moves.send(context.input.name, context.input.to, context.input.ticket),
    ),
    status: os.moves.status.handler((context) => deps.moves.readStatus(context.input.name)),
    reissue: os.moves.reissue.handler((context) => deps.moves.reissueTicket(context.input.name)),
    resume: os.moves.resume.handler((context) =>
      deps.moves.resume(context.input.name, context.input.ticket),
    ),
    abort: os.moves.abort.handler((context) => deps.moves.abort(context.input.name)),
  };
}
