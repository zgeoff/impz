import type { EventCursor, ImpEvent } from '@impz/api';
import { P, match } from 'ts-pattern';

// Each snapshot event carries the head seq, so a cursor taken from one would skip the rest of a
// snapshot that a drop cut short; a reset clears the cursor for the same reason.
export function pickNextCursor(
  cursor: Readonly<EventCursor>,
  event: Readonly<ImpEvent>,
): EventCursor {
  return match(event)
    .with({ ev: 'Reset' }, () => ({}))
    .with({ ev: 'ImpAdded', reason: 'snapshot' }, () => cursor)
    .with(
      {
        ev: P.union(
          'ImpAdded',
          'ImpChanged',
          'ImpRemoved',
          'CheckpointAdded',
          'CheckpointRemoved',
          'GovernorDecision',
          'AgentExec',
        ),
      },
      (logged) => ({ after: logged.seq, logId: logged.logId }),
    )
    .exhaustive();
}
