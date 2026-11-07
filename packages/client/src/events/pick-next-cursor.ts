import type { EventCursor, ImpEvent } from '@impz/api';
import { P, match } from 'ts-pattern';

// A snapshot event carries the head seq, so a cursor taken from one would skip the rest of a
// snapshot that a drop cut short. A reset clears the cursor for the same reason, and a kind from a
// newer impd, whose seq may be of either sort, keeps it.
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
          'Position',
        ),
      },
      (logged) => ({ after: logged.seq, logId: logged.logId }),
    )
    .otherwise(() => cursor);
}
