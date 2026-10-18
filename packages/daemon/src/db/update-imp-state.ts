import type { ColdBootCause, ImpChangeReason, ImpEventDetail, ImpState } from '@impz/api';
import { sql } from 'kysely';
import type { Updateable } from 'kysely';
import { requireTransition } from '../imps/imp-transitions';
import type { ImpRecord } from './imps';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';
import { toImpRecord } from './to-imp-record';

export interface ImpStateChange {
  // why, for the event stream
  readonly reason: ImpChangeReason;
  readonly detail?: ImpEventDetail;
  readonly state: ImpState;
  readonly error?: string | null;

  // set with the error it comes with: an error write without it ends the
  // hold, as a new error replaced the hold's text before the hold had its
  // own column
  readonly hasOopsHold?: boolean;
  readonly oopsBootId?: string | null;
  readonly pid?: number | null;
  readonly sleptAt?: Date | null;
  readonly firecrackerVersion?: string | null;

  // a cold boot that stands in for a wake counts as one, as a `woke` does
  readonly countsWake?: boolean;

  // when a running imp's awake span ends; now by default. A repair passes
  // the last time anything saw the VM alive.
  readonly awakeUntil?: Date;

  // the cause the next cold boot records, whichever path boots it: a repair
  // knows it before that boot (docs/architecture/guest/sessions.md#generations-boots-and-offsets)
  readonly nextBootCause?: Extract<ColdBootCause, 'recovery' | 'wake_fallback'>;
}

// what a compare-and-set state write expects the row to hold
interface ImpStateExpected {
  readonly state: ImpState;
  readonly pid: number | null;
}

// The one writer of an imp's state; a field the change leaves out keeps its
// value, null clears one. With `expected` it is a compare-and-set, which
// gives undefined when something else changed the row first.
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

  let query = db
    .updateTable('imps')
    .set({ ...values, ...buildAwakeValues(change), ...buildBootCauseValues(change) })
    .where('id', '=', id);

  if (expected !== undefined) {
    // an unlocked repair's move passes the lifecycle table too
    if (change.state !== expected.state) {
      requireTransition(expected.state, change.state, `move to ${change.state}`);
    }

    const pidOperator = expected.pid === null ? 'is' : '=';

    query = query.where('state', '=', expected.state).where('pid', pidOperator, expected.pid);
  }

  const returning = query.returningAll();

  // an unguarded write to a missing row throws, as it always has
  const row =
    expected === undefined
      ? await returning.executeTakeFirstOrThrow()
      : await returning.executeTakeFirst();

  return row === undefined ? undefined : emitChange(db, toImpRecord(row), change);
}

// Awake time, in the same write as the state: a running imp's span opens
// once (a re-adopt keeps it), and any other state closes it, a liveness
// repair after a crash included, so the time still counts. A wake counts.
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

  // max() is null while no span is open; an end before the start adds nothing
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
