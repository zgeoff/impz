import type { Checkpoint } from '@impz/api';
import type { Selectable } from 'kysely';
import { appendImpEvent } from './append-imp-event';
import type { ImpDatabase, ImpQueries } from './open-database';
import type { DB } from './schema';
import { withImpTransaction } from './with-imp-transaction';

export interface CheckpointRecord {
  readonly id: string;
  readonly impId: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly sizeBytes: number | null;
  readonly diskBytes: number;
}

export interface NewCheckpoint {
  readonly id: string;
  readonly impId: string;
  readonly label: string | null;
  readonly sizeBytes: number | null;

  readonly diskBytes?: number;

  readonly createdAt?: Date;
}

export function createCheckpoint(
  db: ImpDatabase,
  checkpoint: NewCheckpoint,
): Promise<CheckpointRecord> {
  return withImpTransaction(db, async (trx, at) => {
    const row = await trx
      .insertInto('checkpoints')
      .values({
        id: checkpoint.id,
        imp_id: checkpoint.impId,
        label: checkpoint.label,
        created_at: checkpoint.createdAt?.getTime() ?? Date.now(),
        size_bytes: checkpoint.sizeBytes,
        ...(checkpoint.diskBytes !== undefined && { disk_bytes: checkpoint.diskBytes }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const created = toCheckpointRecord(row);

    await appendCheckpointEvent(trx, at, 'CheckpointAdded', created);

    return created;
  });
}

export async function listCheckpoints(db: ImpDatabase, impId: string): Promise<CheckpointRecord[]> {
  const rows = await db
    .selectFrom('checkpoints')
    .selectAll()
    .where('imp_id', '=', impId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .execute();

  return rows.map((row) => toCheckpointRecord(row));
}

export async function readCheckpoint(
  db: ImpDatabase,
  impId: string,
  ref: string,
): Promise<CheckpointRecord | undefined> {
  const row = await db
    .selectFrom('checkpoints')
    .selectAll()
    .where('imp_id', '=', impId)
    .where((eb) => eb.or([eb('id', '=', ref), eb('label', '=', ref)]))
    .executeTakeFirst();

  return row === undefined ? undefined : toCheckpointRecord(row);
}

export function removeCheckpoint(db: ImpDatabase, id: string): Promise<boolean> {
  return withImpTransaction(db, async (trx, at) => {
    const row = await trx
      .deleteFrom('checkpoints')
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (row === undefined) {
      return false;
    }

    await appendCheckpointEvent(trx, at, 'CheckpointRemoved', toCheckpointRecord(row));

    return true;
  });
}

async function appendCheckpointEvent(
  db: ImpQueries,
  at: number,
  ev: 'CheckpointAdded' | 'CheckpointRemoved',
  checkpoint: CheckpointRecord,
): Promise<void> {
  const imp = await db
    .selectFrom('imps')
    .select('name')
    .where('id', '=', checkpoint.impId)
    .executeTakeFirst();

  if (imp === undefined) {
    return;
  }

  await appendImpEvent(db, { ev, name: imp.name, checkpoint }, at);
}

function toCheckpointRecord(row: Readonly<Selectable<DB['checkpoints']>>): CheckpointRecord {
  return {
    id: row.id,
    impId: row.imp_id,
    label: row.label,
    createdAt: new Date(row.created_at),
    sizeBytes: row.size_bytes,
    diskBytes: row.disk_bytes,
  };
}

export function toApiCheckpoint(checkpoint: CheckpointRecord): Checkpoint {
  return {
    id: checkpoint.id,
    createdAt: checkpoint.createdAt,
    diskMib: Math.ceil(checkpoint.diskBytes / 1_048_576),
    ...(checkpoint.label !== null && { label: checkpoint.label }),
    ...(checkpoint.sizeBytes !== null && { sizeBytes: checkpoint.sizeBytes }),
  };
}
