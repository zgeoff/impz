import { appendEvent } from '@impz/durable';
import type { JsonValue } from '@impz/durable';
import { P, match } from 'ts-pattern';
import * as z from 'zod';
import type { CheckpointRecord } from './checkpoints';
import type { ImpLogEntry, StoredImpLogEntry } from './imp-log-entry';
import type { ImpRecord } from './imps';
import type { ImpQueries } from './open-database';

// Run it in the transaction of the change the event describes, so the two commit together.
export function appendImpEvent(
  db: ImpQueries,
  entry: Readonly<ImpLogEntry>,
  at: number,
): Promise<number> {
  return appendEvent(db, {
    at,
    kind: entry.ev,
    targetId: findTargetId(entry),
    operationId: null,
    payload: toJsonValue(toStoredEntry(entry)),
  });
}

function findTargetId(entry: Readonly<ImpLogEntry>): string | null {
  return match(entry)
    .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) => changed.imp.id)
    .with(
      { ev: P.union('CheckpointAdded', 'CheckpointRemoved') },
      (written) => written.checkpoint.impId,
    )
    .with({ ev: P.union('GovernorDecision', 'AgentExec') }, () => null)
    .exhaustive();
}

const JSON_SCHEMA = z.json();

function toJsonValue(value: StoredImpLogEntry): JsonValue {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- JSON drops a field that holds undefined, which the JSON type has no room for; structuredClone keeps it
  return JSON_SCHEMA.parse(JSON.parse(JSON.stringify(value)));
}

// by hand, not through the schema's encode, which would throw on a value the schema refuses and
// so roll back the change the event describes
function toStoredEntry(entry: Readonly<ImpLogEntry>): StoredImpLogEntry {
  return match(entry)
    .returnType<StoredImpLogEntry>()
    .with({ ev: P.union('ImpAdded', 'ImpChanged', 'ImpRemoved') }, (changed) => ({
      ...changed,
      imp: toStoredImp(changed.imp),
    }))
    .with({ ev: P.union('CheckpointAdded', 'CheckpointRemoved') }, (checkpoint) => ({
      ...checkpoint,
      checkpoint: toStoredCheckpoint(checkpoint.checkpoint),
    }))
    .with({ ev: P.union('GovernorDecision', 'AgentExec') }, (other) => other)
    .exhaustive();
}

function toStoredImp(imp: Readonly<ImpRecord>) {
  return {
    ...imp,
    createdAt: imp.createdAt.getTime(),
    lastActiveAt: imp.lastActiveAt.getTime(),
    lastRequestAt: imp.lastRequestAt?.getTime() ?? null,
    sleptAt: imp.sleptAt?.getTime() ?? null,
    holdUntil: imp.holdUntil?.getTime() ?? null,
    awakeSince: imp.awakeSince?.getTime() ?? null,
  };
}

function toStoredCheckpoint(checkpoint: Readonly<CheckpointRecord>) {
  return { ...checkpoint, createdAt: checkpoint.createdAt.getTime() };
}
