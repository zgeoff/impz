import { EVENT_VERSION, isImpAllowed } from '@impz/api';
import type { ImpEvent } from '@impz/api';
import { getErrorMessage } from '@impz/shared';
import { P, match } from 'ts-pattern';
import { createEventCheck } from '../platform/events/event-check';
import { openEventStream } from '../platform/events/event-stream';
import type { EventLogReads } from '../platform/events/event-stream';
import { readEventPage } from '../platform/events/read-event-page';
import type { Caller } from '../platform/principal/caller';
import { getImpdLogger } from '../platform/process/get-impd-logger';
import { mergeSignals } from '../platform/process/merge-signals';
import type { CallerImps } from './build-caller-imps';
import type { RpcImplementer } from './create-implementer';
import type { RouterDeps } from './create-router';
import { readApiEvent } from './read-api-event';

const LIST_LIMIT = 100;

export function createEventRoutes(os: RpcImplementer, deps: RouterDeps, views: CallerImps) {
  const isEventValid = createEventCheck({ now: deps.now });

  const buildCallerReads = (caller: Readonly<Caller>): EventLogReads => ({
    readHead: deps.imps.events.readHead,
    readLogId: deps.imps.events.readLogId,
    readAfter: deps.imps.events.readAfter,
    readSnapshot: async (head, logId) => {
      const imps = await views.listCallerImps(caller);

      const at = new Date(deps.now());

      return imps
        .map((imp): ImpEvent =>
          // oxlint-disable-next-line id-length -- `v` is the event format's version field
          ({ v: EVENT_VERSION, at, seq: head, logId, ev: 'ImpAdded', reason: 'snapshot', imp }),
        )
        .filter((event) => isEventValid(event));
    },
    present: async (event, logId) => {
      try {
        return await readApiEvent(event, deps.imps.toApi, logId);
      } catch (error) {
        getImpdLogger('events').warning('left out event {seq}: {error}', {
          seq: event.seq,
          error: getErrorMessage(error),
        });

        return null;
      }
    },
    accepts: (event) => isEventValid(event) && isCallerEvent(caller, event),
    now: deps.now,
  });

  return {
    stream: os.events.stream.handler((options) => {
      const caller = options.context.caller;

      return openEventStream({
        ...buildCallerReads(caller),
        cursor: options.input ?? {},
        changes: deps.imps.events.changes,
        signal: mergeSignals(options.signal, options.context.ends),
        endsAt: caller.expiresAt,
      });
    }),

    list: os.events.list.handler((options) =>
      readEventPage(
        buildCallerReads(options.context.caller),
        options.input,
        options.input.limit ?? LIST_LIMIT,
      ),
    ),
  };
}

function isCallerEvent(caller: Readonly<Caller>, event: ImpEvent): boolean {
  return match(event)
    .with({ ev: 'Reset' }, () => true)
    .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) =>
      isImpAllowed(caller.imps, changed.imp.name),
    )
    .with(
      { ev: P.union('CheckpointAdded', 'CheckpointRemoved', 'GovernorDecision', 'AgentExec') },
      (named) => isImpAllowed(caller.imps, named.name),
    )
    .exhaustive();
}
