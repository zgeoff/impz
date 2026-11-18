import type { ColdBootCause, ImpChangeReason, ImpEventDetail, ImpState } from '@impz/api';
import type { ExpressionBuilder, Updateable } from 'kysely';
import { buildNotFoundError } from '../errors/build-not-found-error';
import { appendImpChange } from './append-imp-change';
import type { DB } from './db';
import type { ImpRecord } from './imps';
import type { ImpDatabase } from './open-database';
import { requireTransition } from './require-transition';
import { toImpRecord } from './to-imp-record';
import { withImpTransaction } from './with-imp-transaction';

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

  const changed = await withImpTransaction(db, async (trx, at) => {
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

    const row = await trx
      .updateTable('imps')
      .set((eb) => ({
        ...values,
        ...buildAwakeValues(eb, change),
        ...buildBootCauseValues(change),
      }))
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    return appendImpChange(trx, at, toImpRecord(row), change);
  });

  if (changed !== null) {
    return changed;
  }

  if (expected === undefined) {
    throw buildNotFoundError('imp', id);
  }

  return undefined;
}

function buildAwakeValues(eb: ExpressionBuilder<DB, 'imps'>, change: Readonly<ImpStateChange>) {
  const now = Date.now();

  if (change.state === 'running') {
    const isWake = change.reason === 'woke' || change.countsWake === true;

    return {
      awake_since: eb.fn.coalesce('awake_since', eb.val(now)),
      ...(isWake && { wake_count: eb('wake_count', '+', 1) }),
    };
  }

  const until = change.awakeUntil?.getTime() ?? now;

  // an imp with no awake_since adds nothing
  const awakeFor = eb(eb.val(until), '-', eb.ref('awake_since'));

  // oxlint-disable-next-line promise/prefer-await-to-then -- Kysely's case builder names its branch then
  const counted = eb.case().when(awakeFor, '>', 0).then(awakeFor).else(0).end();

  return {
    awake_ms: eb('awake_ms', '+', counted),
    awake_since: null,
  };
}

function buildBootCauseValues(change: Readonly<ImpStateChange>) {
  return change.nextBootCause === undefined ? {} : { next_boot_cause: change.nextBootCause };
}
