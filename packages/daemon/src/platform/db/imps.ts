import type { EgressPolicy, ImpKind, ImpState, MoveState, PublicAuth } from '@impz/api';
import { sql } from 'kysely';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import { MOVE_TRANSITIONS } from '../../imp-ops/moves/move-transitions';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-369 moves this to the layer that owns it
import { requireTransition } from '../../imps/imps/imp-transitions';
import { getErrorMessage } from '../process/get-error-message';
import { allocateSlot } from './allocate-slot';
import { ImpClashError } from './imp-clash-error';
import type { ImpDatabase, ImpQueries } from './open-database';
import { SlotTakenError } from './slot-taken-error';
import { toImpRecord } from './to-imp-record';

export interface ImpRecord {
  readonly id: string;
  readonly name: string;
  readonly imageId: string;
  readonly state: ImpState;
  readonly kind: ImpKind;
  readonly vcpus: number;
  readonly memoryMib: number;

  readonly maxMemoryMib: number;
  readonly slot: number;
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly sleptAt: Date | null;
  readonly holdUntil: Date | null;
  readonly error: string | null;

  readonly hasOopsHold: boolean;

  readonly oopsBootId: string | null;
  readonly pid: number | null;
  readonly firecrackerVersion: string | null;
  readonly httpPort: number;
  readonly diskBytes: number;
  readonly isDiskGrowPending: boolean;

  readonly publicAuth: PublicAuth | null;
  readonly cpu: CpuSettings;
  readonly wakeCount: number;

  readonly jailUid: number | null;

  readonly awakeMs: number;
  readonly awakeSince: Date | null;

  readonly isIdentityResetPending: boolean;

  readonly isBackedUp: boolean;

  readonly isTrustPending: boolean;

  readonly moveState: MoveState | null;
}

export interface CpuSettings {
  readonly limit: number | null;
  readonly weight: number;
}

export interface NewImp {
  readonly id?: string;
  readonly name: string;
  readonly imageId: string;
  readonly vcpus: number;
  readonly memoryMib: number;

  readonly maxMemoryMib?: number;
  readonly slot: number;
  readonly ip: string;
  readonly httpPort?: number;

  readonly diskBytes?: number;

  readonly egress?: EgressPolicy;
  readonly cpu?: CpuSettings;
  readonly isIdentityResetPending?: boolean;

  readonly isBackedUp?: boolean;

  readonly networkIds?: readonly string[];

  readonly moveState?: MoveState;

  readonly kind?: ImpKind;
}

// far above any account in the host image; an imp keeps its uid for life
export const JAIL_UIDS = { first: 900_000, count: 65_536 } as const;
export const TEMPLATE_BUILD_UID = JAIL_UIDS.first - 1;

async function allocateJailUid(db: ImpQueries): Promise<number> {
  const rows = await db
    .selectFrom('imps')
    .select('jail_uid')
    .where('jail_uid', 'is not', null)
    .orderBy('jail_uid')
    .execute();

  let uid = JAIL_UIDS.first;

  for (const row of rows) {
    if (row.jail_uid !== uid) {
      break;
    }

    uid += 1;
  }

  if (uid >= JAIL_UIDS.first + JAIL_UIDS.count) {
    throw new Error(`every one of the ${String(JAIL_UIDS.count)} jail uids is taken`);
  }

  return uid;
}

export async function createImp(db: ImpDatabase, imp: NewImp): Promise<ImpRecord> {
  const created = await writeImpRow(db, imp);

  db.writes.publish({ kind: 'added', imp: created });

  return created;
}

// emits nothing: the caller emits once the row is committed
async function writeImpRow(db: ImpQueries, imp: NewImp): Promise<ImpRecord> {
  const now = Date.now();

  const jailUid = await allocateJailUid(db);

  const row = await db
    .insertInto('imps')
    .values({
      id: imp.id ?? Bun.randomUUIDv7(),
      name: imp.name,
      image_id: imp.imageId,
      state: 'creating',
      vcpus: imp.vcpus,
      memory_mib: imp.memoryMib,
      max_memory_mib:
        imp.maxMemoryMib === undefined || imp.maxMemoryMib === imp.memoryMib
          ? null
          : imp.maxMemoryMib,
      slot: imp.slot,
      ip: imp.ip,
      ...(imp.httpPort !== undefined && { http_port: imp.httpPort }),
      ...(imp.diskBytes !== undefined && { disk_bytes: imp.diskBytes }),
      ...(imp.isIdentityResetPending === true && { identity_reset_pending: 1 }),
      ...(imp.isBackedUp === false && { backup: 0 }),
      ...(imp.egress !== undefined && {
        egress_policy: imp.egress.mode,
        egress_allow: JSON.stringify(imp.egress.allow),
      }),
      ...(imp.cpu !== undefined && { cpu_limit: imp.cpu.limit, cpu_weight: imp.cpu.weight }),
      ...(imp.moveState !== undefined && { move_state: imp.moveState }),
      ...(imp.kind !== undefined && { kind: imp.kind }),
      created_at: now,
      last_active_at: now,
      jail_uid: jailUid,
    })
    .returningAll()
    .executeTakeFirstOrThrow()
    .catch((error: unknown) => {
      throw toImpClash(error) ?? error;
    });

  if (imp.networkIds !== undefined && imp.networkIds.length > 0) {
    await db
      .insertInto('network_members')
      .values(imp.networkIds.map((networkId) => ({ network_id: networkId, imp_id: row.id })))
      .execute();
  }

  return toImpRecord(row);
}

// SQLite names the column in its message: `UNIQUE constraint failed: imps.name`
function toImpClash(error: unknown): ImpClashError | null {
  const isUnique =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE';

  const match = isUnique ? /\bimps\.(?<column>\w+)/v.exec(getErrorMessage(error)) : null;
  const column = match?.groups?.['column'];

  return column === undefined ? null : new ImpClashError(column);
}

interface FreeSlots {
  readonly count: number;
  readonly findIp: (slot: number) => string;

  readonly slot?: number | undefined;

  readonly now?: () => number;
}

export async function createImpInFreeSlot(
  db: ImpDatabase,
  imp: Omit<NewImp, 'slot' | 'ip'>,
  slots: FreeSlots,
): Promise<ImpRecord> {
  const created = await db.transaction().execute(async (trx) => {
    if (slots.slot === undefined) {
      const slot = await allocateSlot(trx, slots.count, (slots.now ?? Date.now)());

      return writeImpRow(trx, { ...imp, slot, ip: slots.findIp(slot) });
    }

    const holder = await trx
      .selectFrom('imps')
      .select('id')
      .where('slot', '=', slots.slot)
      .executeTakeFirst();

    if (holder !== undefined || slots.slot >= slots.count) {
      throw new SlotTakenError(slots.slot);
    }

    return writeImpRow(trx, { ...imp, slot: slots.slot, ip: slots.findIp(slots.slot) });
  });

  db.writes.publish({ kind: 'added', imp: created });

  return created;
}

export async function readImpByName(db: ImpDatabase, name: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function readImpById(db: ImpDatabase, id: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function listImps(db: ImpDatabase): Promise<ImpRecord[]> {
  const rows = await db.selectFrom('imps').selectAll().orderBy('name').execute();

  return rows.map((row) => toImpRecord(row));
}

export async function countImpsByState(db: ImpDatabase): Promise<Map<ImpState, number>> {
  const rows = await db
    .selectFrom('imps')
    .select((eb) => ['state', eb.fn.countAll<number>().as('count')])
    .groupBy('state')
    .execute();

  return new Map(rows.map((row) => [row.state, row.count]));
}

interface ImpSettings {
  readonly cpu: Readonly<CpuSettings>;
  readonly vcpus: number;
  readonly httpPort: number;
}

export async function updateImpSettings(
  db: ImpDatabase,
  id: string,
  settings: Readonly<ImpSettings>,
): Promise<ImpRecord> {
  const cpu = settings.cpu;

  const row = await db
    .updateTable('imps')
    .set({
      cpu_limit: cpu.limit,
      cpu_weight: cpu.weight,
      vcpus: settings.vcpus,
      http_port: settings.httpPort,
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const imp = toImpRecord(row);

  db.writes.publish({ kind: 'changed', imp, reason: 'updated' });

  return imp;
}

export async function updateImpCommitted(
  db: ImpDatabase,
  id: string,
  committedAt: number,
  isWarm = false,
): Promise<ImpRecord> {
  const row = await db.transaction().execute(async (trx) => {
    if (isWarm) {
      const received = await trx
        .selectFrom('imps')
        .select('state')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      requireTransition(received.state, 'sleeping', 'commit a warm move', 'warm move');
    }

    const updated = await trx
      .updateTable('imps')
      .set({
        move_state: null,
        ...(isWarm && { state: 'sleeping', slept_at: committedAt, trust_pending: 1 }),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();

    await trx
      .updateTable('move_tickets')
      .set({ committed_at: committedAt })
      .where('imp_id', '=', id)
      .execute();

    return updated;
  });

  const imp = toImpRecord(row);

  db.writes.publish({ kind: 'changed', imp, reason: 'updated' });

  return imp;
}

export async function claimTrustPending(db: ImpDatabase, id: string): Promise<boolean> {
  const taken = await db
    .updateTable('imps')
    .set({ trust_pending: 0 })
    .where('id', '=', id)
    .where('trust_pending', '=', 1)
    .returning('id')
    .executeTakeFirst();

  return taken !== undefined;
}

export async function updateImpMove(
  db: ImpDatabase,
  id: string,
  moveState: MoveState | null,
): Promise<ImpRecord> {
  const row = await db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('imps')
      .select('move_state')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const from = current.move_state;
    const isListed = MOVE_TRANSITIONS.some(([each, next]) => each === from && next === moveState);

    if (from !== moveState && !isListed) {
      throw new Error(
        `imp ${id}: the move mark cannot go from ${String(from)} to ${String(moveState)}`,
      );
    }

    return trx
      .updateTable('imps')
      .set({ move_state: moveState })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  });

  const imp = toImpRecord(row);

  db.writes.publish({ kind: 'changed', imp, reason: 'updated' });

  return imp;
}

export async function updateImpActivity(db: ImpDatabase, id: string, at: Date): Promise<void> {
  await db.updateTable('imps').set({ last_active_at: at.getTime() }).where('id', '=', id).execute();
}

export async function updateImpDisk(
  db: ImpDatabase,
  id: string,
  disk: Readonly<{ diskBytes: number; isGrowPending: boolean }>,
): Promise<ImpRecord> {
  const before = await readImpById(db, id);

  const row = await db
    .updateTable('imps')
    .set({ disk_bytes: disk.diskBytes, disk_grow_pending: disk.isGrowPending ? 1 : 0 })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const sized = toImpRecord(row);

  if (before?.diskBytes !== sized.diskBytes) {
    db.writes.publish({ kind: 'changed', imp: sized, reason: 'resized' });
  }

  return sized;
}

// A lease with no end counts as one that ends at the last time a Date holds.
const NO_END_MS = 8_640_000_000_000_000;

// Run it in the lease write's transaction.
export async function updateImpHold(db: ImpQueries, id: string): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set((eb) => ({
      hold_until: eb
        .selectFrom('imp_leases')
        .select((inner) => inner.fn.max(inner.fn.coalesce('until', sql.lit(NO_END_MS))).as('end'))
        .where('imp_id', '=', id),
    }))
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

export interface StoredPublicAuth {
  readonly auth: PublicAuth;
  readonly user: string | null;
  readonly hash: string | null;
}

export async function updateImpExposure(
  db: ImpDatabase,
  id: string,
  exposure: StoredPublicAuth | null,
): Promise<ImpRecord | undefined> {
  const row = await db
    .updateTable('imps')
    .set({
      exposure: exposure === null ? 'tailnet' : 'public',
      public_auth: exposure?.auth ?? null,
      public_user: exposure?.user ?? null,
      public_hash: exposure?.hash ?? null,
    })
    .where('id', '=', id)
    .where('move_state', 'is', null)
    .returningAll()
    .executeTakeFirst();

  if (row === undefined) {
    return undefined;
  }

  const changed = toImpRecord(row);

  db.writes.publish({ kind: 'changed', imp: changed, reason: 'exposed' });

  return changed;
}

export async function removeImp(db: ImpDatabase, id: string): Promise<boolean> {
  const row = await db.deleteFrom('imps').where('id', '=', id).returningAll().executeTakeFirst();

  if (row === undefined) {
    return false;
  }

  db.writes.publish({ kind: 'removed', imp: toImpRecord(row) });

  return true;
}

export async function removeIdentityReset(db: ImpDatabase, id: string): Promise<ImpRecord> {
  const row = await db
    .updateTable('imps')
    .set({ identity_reset_pending: 0 })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImpRecord(row);
}

export async function countImpsUsingImage(db: ImpDatabase, imageId: string): Promise<number> {
  const row = await db
    .selectFrom('imps')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('image_id', '=', imageId)
    .executeTakeFirstOrThrow();

  return row.count;
}
