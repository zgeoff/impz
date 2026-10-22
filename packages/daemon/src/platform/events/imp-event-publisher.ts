import { EVENT_VERSION } from '@impz/api';
import type { Imp, ImpEvent } from '@impz/api';
import { P, match } from 'ts-pattern';
import { toApiCheckpoint } from '../db/checkpoints';
import type { ImpWrite } from '../db/imp-write-feed';
import { readImpById } from '../db/imps';
import type { ImpRecord } from '../db/imps';
import type { ImpDatabase } from '../db/open-database';
import { getErrorMessage } from '../process/get-error-message';
import type { EventBus } from './event-bus';

interface PublisherDeps {
  readonly db: ImpDatabase;
  readonly bus: EventBus;
  readonly toApi: (imp: ImpRecord) => Promise<Imp>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

export function startImpEventPublisher(deps: PublisherDeps): () => void {
  const pending: ImpWrite[] = [];
  const state = { draining: false };

  const drain = async (): Promise<void> => {
    state.draining = true;

    for (let write = pending.shift(); write !== undefined; write = pending.shift()) {
      try {
        const event = await readEvent(deps, write);

        if (event !== null) {
          deps.bus.publish(event);
        }
      } catch (error) {
        deps.log(`impd: events: ${getErrorMessage(error)}`);
      }
    }

    state.draining = false;
  };

  return deps.db.writes.subscribe((write) => {
    pending.push(write);

    if (!state.draining) {
      void drain();
    }
  });
}

function readEvent(deps: PublisherDeps, write: Readonly<ImpWrite>): Promise<ImpEvent | null> {
  // oxlint-disable-next-line id-length -- `v` is the event format's version field
  const envelope = { v: EVENT_VERSION, at: new Date(deps.now()) } as const;

  return match(write)
    .returnType<Promise<ImpEvent | null>>()
    .with({ kind: 'added' }, async (added) => ({
      ...envelope,
      ev: 'ImpAdded',
      reason: 'created',
      imp: await deps.toApi(added.imp),
    }))
    .with({ kind: 'changed' }, async (changed) => ({
      ...envelope,
      ev: 'ImpChanged',
      reason: changed.reason,
      imp: await deps.toApi(changed.imp),
      ...(changed.detail !== undefined && { detail: changed.detail }),
    }))
    .with({ kind: 'removed' }, async (removed) => ({
      ...envelope,
      ev: 'ImpRemoved',
      imp: await deps.toApi(removed.imp),
    }))
    .with({ kind: P.union('checkpointAdded', 'checkpointRemoved') }, async (checkpointWrite) => {
      const imp = await readImpById(deps.db, checkpointWrite.checkpoint.impId);

      if (imp === undefined) {
        return null;
      }

      const ev =
        checkpointWrite.kind === 'checkpointAdded' ? 'CheckpointAdded' : 'CheckpointRemoved';

      return {
        ...envelope,
        ev,
        name: imp.name,
        checkpoint: toApiCheckpoint(checkpointWrite.checkpoint),
      };
    })
    .exhaustive();
}
