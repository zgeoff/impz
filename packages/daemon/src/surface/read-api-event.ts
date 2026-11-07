import { EVENT_VERSION } from '@impz/api';
import type { Imp, ImpEvent } from '@impz/api';
import { P, match } from 'ts-pattern';
import { toApiCheckpoint } from '../platform/db/checkpoints';
import type { LoggedImpEvent } from '../platform/db/imp-log-entry';
import type { ImpRecord } from '../platform/db/imps';

// the imp is presented as the stream reads the event, so its live fields, such as RAM in use,
// are those of the read
export function readApiEvent(
  event: Readonly<LoggedImpEvent>,
  toApi: (imp: ImpRecord) => Promise<Imp>,
): Promise<ImpEvent> {
  // oxlint-disable-next-line id-length -- `v` is the event format's version field
  const envelope = { v: EVENT_VERSION, at: event.at } as const;

  return match(event)
    .returnType<Promise<ImpEvent>>()
    .with({ ev: 'ImpAdded' }, async (added) => ({
      ...envelope,
      ev: 'ImpAdded',
      reason: 'created',
      imp: await toApi(added.imp),
    }))
    .with({ ev: 'ImpChanged' }, async (changed) => ({
      ...envelope,
      ev: 'ImpChanged',
      reason: changed.reason,
      imp: await toApi(changed.imp),
      ...(changed.detail !== undefined && { detail: changed.detail }),
    }))
    .with({ ev: 'ImpRemoved' }, async (removed) => ({
      ...envelope,
      ev: 'ImpRemoved',
      imp: await toApi(removed.imp),
    }))
    .with({ ev: P.union('CheckpointAdded', 'CheckpointRemoved') }, (written) =>
      Promise.resolve({
        ...envelope,
        ev: written.ev,
        name: written.name,
        checkpoint: toApiCheckpoint(written.checkpoint),
      }),
    )
    .with({ ev: P.union('GovernorDecision', 'AgentExec') }, (other) => {
      const { seq: _seq, at: _at, ...fields } = other;

      return Promise.resolve({ ...envelope, ...fields });
    })
    .exhaustive();
}
