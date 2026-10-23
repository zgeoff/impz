import { findForkAuthority } from '../identity/auth/access-policy';
import { requireLeaseHolder } from '../identity/auth/caller-view';
import { buildForbiddenError } from '../platform/errors/impd-errors';
import { formatCaller, isCallerAllowed } from '../platform/principal/caller';
import type { CallerImps } from './build-caller-imps';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createImpRoutes(os: RpcImplementer, deps: RouterDeps, views: CallerImps) {
  return {
    create: os.imps.create.handler(async (context) => {
      const caller = context.context.caller;
      const { networks, backup, ...input } = context.input;

      if (networks !== undefined && caller.imps !== null) {
        throw buildForbiddenError(
          `${formatCaller(caller)} is limited to some imps, so it cannot put an imp on a network`,
        );
      }

      if (caller.imps !== null) {
        const image = await deps.images.resolveImage(input.image);

        if (image.sourceImp !== null && !isCallerAllowed(caller, 'manage', image.sourceImp)) {
          throw buildForbiddenError(
            `${formatCaller(caller)} may not copy imp ${image.sourceImp}, the source of template ${image.name}`,
          );
        }
      }

      const networkIds = await deps.networks.resolveNetworkIds(networks ?? []);

      return views.readCallerImp(
        caller,
        deps.imps.createImp({ ...input, networkIds, isBackedUp: backup }),
      );
    }),
    list: os.imps.list.handler(async (context) => {
      const caller = context.context.caller;
      const builders = context.input?.builders === true;

      const imps = await views.listCallerImps(caller);

      return views.readCallerImps(
        caller,
        imps.filter((imp) => builders || imp.kind !== 'builder'),
      );
    }),
    get: os.imps.get.handler((context) =>
      views.readCallerImp(context.context.caller, deps.imps.readImp(context.input.name)),
    ),
    destroy: os.imps.destroy.handler(async (context) => {
      await deps.imps.destroyImp(context.input.name);

      return {};
    }),
    start: os.imps.start.handler((context) =>
      views.readCallerImp(context.context.caller, deps.imps.startImp(context.input.name)),
    ),
    stop: os.imps.stop.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.imps.stopImp(context.input.name, context.input.force ?? false),
      ),
    ),
    sleep: os.imps.sleep.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.imps.sleepImp(context.input.name, context.input.force ?? false),
      ),
    ),
    wake: os.imps.wake.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.imps.wakeImp(context.input.name, context.input.restartError),
      ),
    ),
    hold: os.imps.hold.handler((context) => {
      const caller = context.context.caller;

      return views.readCallerImp(
        caller,
        deps.imps.holdImp(context.input.name, context.input.seconds, requireLeaseHolder(caller)),
      );
    }),
    resizeDisk: os.imps.resizeDisk.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.imps.resizeDisk(context.input.name, context.input.diskMib),
      ),
    ),
    update: os.imps.update.handler((context) =>
      views.readCallerImp(
        context.context.caller,
        deps.imps.updateImp(context.input.name, context.input),
      ),
    ),
    url: os.imps.url.handler((context) => deps.imps.readUrls(context.input.name)),
    policy: os.imps.policy.handler((context) => deps.egress.readPolicy(context.input.name)),
    setPolicy: os.imps.setPolicy.handler((context) =>
      deps.egress.setPolicy(context.input.name, context.input.policy),
    ),

    expose: os.imps.expose.handler((context) => deps.exposure.expose(context.input)),
    unexpose: os.imps.unexpose.handler(async (context) => {
      await deps.exposure.unexpose(context.input.name);

      return views.readCallerImp(context.context.caller, deps.imps.readImp(context.input.name));
    }),
    fork: os.imps.fork.handler(async (context) => {
      const caller = context.context.caller;

      const forked = await deps.checkpoints.forkImp(context.input);

      const copied = await deps.broker.createForkGrants(
        { id: forked.sourceId, name: context.input.source },
        forked.imp,
        findForkAuthority(caller),
      );

      return {
        ...(await views.readCallerImp(caller, forked.imp)),
        grantsNotCopied: copied.notCopied,
        ...(copied.error !== null && { grantsError: copied.error }),
      };
    }),
  };
}
