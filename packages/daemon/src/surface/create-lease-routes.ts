import { isLeaseVisible, requireLeaseHolder, toApiLease } from '../identity/auth/caller-view';
import { isCallerAllowed } from '../platform/principal/caller';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';
import { requireNamedImp } from './require-named-imp';

export function createLeaseRoutes(os: RpcImplementer, deps: RouterDeps) {
  return {
    acquire: os.leases.acquire.handler(async (context) => {
      const input = context.input;
      const caller = context.context.caller;

      const acquired = await deps.imps.acquireLease(
        input.name,
        requireLeaseHolder(caller),
        input.label,
        input.ttlSeconds,
      );

      return toApiLease(acquired.name, acquired.lease);
    }),
    renew: os.leases.renew.handler(async (context) => {
      const input = context.input;
      const caller = context.context.caller;

      const renewed = await deps.imps.renewLease(
        input.name,
        requireLeaseHolder(caller),
        input.label,
        input.ttlSeconds,
      );

      return toApiLease(renewed.name, renewed.lease);
    }),
    release: os.leases.release.handler(async (context) => {
      const input = context.input;
      const caller = context.context.caller;
      const holder = requireLeaseHolder(caller);

      const released = await deps.imps.releaseLease(input.name, holder, input.label);

      return { released };
    }),
    list: os.leases.list.handler(async (context) => {
      const caller = context.context.caller;
      const name = context.input.name;
      const label = context.input.label;

      requireNamedImp(caller, name, 'exec');

      if (name !== undefined) {
        await deps.imps.readImp(name);
      }

      const leases = await deps.imps.listLeases();

      return leases
        .filter(
          (each) =>
            (name === undefined || each.name === name) &&
            (label === undefined || each.lease.label === label) &&
            isCallerAllowed(caller, 'exec', each.name) &&
            isLeaseVisible(caller, each.lease),
        )
        .map((each) => toApiLease(each.name, each.lease));
    }),
  };
}
