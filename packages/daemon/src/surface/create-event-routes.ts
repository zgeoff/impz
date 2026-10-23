import { EVENT_VERSION, isImpAllowed } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { createEventCheck } from '../platform/events/event-check';
import { openEventStream } from '../platform/events/event-stream';
import { mergeSignals } from '../platform/process/merge-signals';
import type { CallerImps } from './build-caller-imps';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';

export function createEventRoutes(os: RpcImplementer, deps: RouterDeps, views: CallerImps) {
  const isEventValid = createEventCheck({ log: deps.log, now: deps.now });

  return {
    stream: os.events.stream.handler((options) => {
      const caller = options.context.caller;

      return openEventStream({
        bus: deps.imps.events,
        readSnapshot: async () => {
          const imps = await views.listCallerImps(caller);

          const at = new Date(deps.now());

          return imps
            .map((imp): ImpEvent =>
              // oxlint-disable-next-line id-length -- `v` is the event format's version field
              ({ v: EVENT_VERSION, at, ev: 'ImpAdded', reason: 'snapshot', imp }),
            )
            .filter((event) => isEventValid(event));
        },
        signal: mergeSignals(options.signal, options.context.ends),
        endsAt: caller.expiresAt,
        now: deps.now,
        accepts: (event) =>
          isEventValid(event) && isImpAllowed(caller.imps, readEventImpName(event)),
      });
    }),
  };
}

function readEventImpName(event: ImpEvent): string {
  return 'imp' in event ? event.imp.name : event.name;
}
