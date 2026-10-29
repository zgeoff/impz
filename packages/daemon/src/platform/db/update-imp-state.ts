import type { ColdBootCause, ImpChangeReason, ImpEventDetail, ImpState } from '@impz/api';
import { sql } from 'kysely';
import type { Updateable } from 'kysely';
import { buildNotFoundError } from '../errors/impd-errors';
import { requireTransition } from './imp-transitions';
import type { ImpRecord } from './imps';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';
import { toImpRecord } from './to-imp-record';

export interface ImpStateChange {
  readonly reason: ImpChangeReason;
  readonly detail?: ImpEventDetail;
  readonly state: ImpState;
  readonly error?: string | null;

  readonly hasOopsHold?: boolean;
  readonly oopsBootId?: string | null;
  readonly pid?: number | null;
  readonly sleptAt?: Date | null;
  readonly firecrackerVersion?: string | null;

  readonly countsWake?: boolean;

  readonly awakeUntil?: Date;

  readonly nextBootCause?: Extract<ColdBootCause, 'recovery' | 'wake_fallback'>;
}

interface ImpStateExpected {
  readonly state: ImpState;
  readonly pid: number | null;
}

export async function updateImpState(
  db: ImpDatabase,
  id: string,
  change: Readonly<ImpStateChange>,
): Promise<ImpRecord>;

export async function updateImpState(
  db: ImpDatabase,
  id: string,
  change: Readonly<ImpStateChange>,
  expected: Readonly<ImpStateExpected>,
): Promise<ImpRecord | undefined>;

export async function updateImpState(
  db: ImpDatabase,
  id: string,
  change: Readonly<ImpStateChange>,
  expected?: Readonly<ImpStateExpected>,
): Promise<ImpRecord | undefined> {
  const values: Updateable<DB['imps']> = { state: change.state };

  if (change.error !== undefined) {
    values.error = change.error;
  }

  if (change.error !== undefined || change.hasOopsHold !== undefined) {
    values.oops_hold = change.hasOopsHold === true ? 1 : 0;
  }

  if (change.oopsBootId !== undefined) {
    values.oops_boot_id = change.oopsBootId;
  }

  if (change.pid !== undefined) {
    values.pid = change.pid;
  }

  if (change.sleptAt !== undefined) {
    values.slept_at = change.sleptAt === null ? null : change.sleptAt.getTime();
  }

  if (change.firecrackerVersion !== undefined) {
    values.firecracker_version = change.firecrackerVersion;
  }

  const row = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('imps')
      .select(['state', 'pid'])
      .where('id', '=', id)
      .executeTakeFirst();

    if (current === undefined) {
      return null;
    }

    if (
      expected !== undefined &&
      (current.state !== expected.state || current.pid !== expected.pid)
    ) {
      return null;
    }

    if (change.state !== current.state) {
      requireTransition(current.state, change.state, `move to ${change.state}`);
    }

    return trx
      .updateTable('imps')
      .set({ ...values, ...buildAwakeValues(change), ...buildBootCauseValues(change) })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });

  if (row !== null) {
    return emitChange(db, toImpRecord(row), change);
  }

  if (expected === undefined) {
    throw buildNotFoundError('imp', id);
  }

  return undefined;
}

function buildAwakeValues(change: Readonly<ImpStateChange>) {
  const now = Date.now();

  if (change.state === 'running') {
    const isWake = change.reason === 'woke' || change.countsWake === true;

    return {
      awake_since: sql<number>`coalesce(awake_since, ${now})`,
      ...(isWake && { wake_count: sql<number>`wake_count + 1` }),
    };
  }

  const until = change.awakeUntil?.getTime() ?? now;

  return {
    awake_ms: sql<number>`awake_ms + coalesce(max(0, ${until} - awake_since), 0)`,
    awake_since: null,
  };
}

function buildBootCauseValues(change: Readonly<ImpStateChange>) {
  return change.nextBootCause === undefined ? {} : { next_boot_cause: change.nextBootCause };
}

function emitChange(
  db: ImpDatabase,
  imp: Readonly<ImpRecord>,
  change: Readonly<ImpStateChange>,
): ImpRecord {
  db.writes.publish({
    kind: 'changed',
    imp,
    reason: change.reason,
    ...(change.detail !== undefined && { detail: change.detail }),
  });

  return imp;
}
