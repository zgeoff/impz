import type { EgressPolicy, ImpKind, ImpState, MoveState, PublicAuth } from '@impz/api';
import { sql } from 'kysely';
import { MOVE_TRANSITIONS } from '../../imp-ops/moves/move-transitions';
import { requireTransition } from '../../imps/imps/imp-transitions';
import { readErrorMessage } from '../process/read-error-message';
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

  // what the guest may grow to (docs/architecture/lifecycle/elastic-memory.md); memoryMib for
  // an imp that does not grow
  readonly maxMemoryMib: number;
  readonly slot: number;
  readonly ip: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  readonly sleptAt: Date | null;
  readonly holdUntil: Date | null;
  readonly error: string | null;

  // whether a kernel oops holds the imp's disk until the host reboots
  readonly hasOopsHold: boolean;

  // the kernel's boot id when a kernel oops began to hold the imp's disk;
  // null without a hold, and on a hold from before impd recorded it
  readonly oopsBootId: string | null;
  readonly pid: number | null;
  readonly firecrackerVersion: string | null;
  readonly httpPort: number;
  readonly diskBytes: number;
  readonly isDiskGrowPending: boolean;

  // what a public imp asks for; null while it is tailnet-only
  readonly publicAuth: PublicAuth | null;
  readonly cpu: CpuSettings;
  readonly wakeCount: number;

  // its jailed Firecracker's uid and gid (JAIL_UIDS); null only for a row
  // the migration could not number
  readonly jailUid: number | null;

  // awake time up to awakeSince; while the imp runs, add the time since
  readonly awakeMs: number;
  readonly awakeSince: Date | null;

  // an imp from a template, not yet booted with its own machine-id and ssh
  // host keys (docs/guides/templates.md#identity)
  readonly isIdentityResetPending: boolean;

  // false for an imp left out of every backup run, set at create
  // (docs/architecture/storage/backups.md#imps-left-out)
  readonly isBackedUp: boolean;

  // a warm move's imp until its first wake here (docs/architecture/storage/moves.md#warm-moves)
  readonly isTrustPending: boolean;

  // set while the imp moves between hosts (moves/)
  readonly moveState: MoveState | null;
}

// cores the VM may use (null: no limit) and its cgroup cpu.weight
export interface CpuSettings {
  readonly limit: number | null;
  readonly weight: number;
}

export interface NewImp {
  // a fresh UUIDv7 when left out
  readonly id?: string;
  readonly name: string;
  readonly imageId: string;
  readonly vcpus: number;
  readonly memoryMib: number;

  // memoryMib when left out: the guest does not grow
  readonly maxMemoryMib?: number;
  readonly slot: number;
  readonly ip: string;
  readonly httpPort?: number;

  // 32 GiB when left out
  readonly diskBytes?: number;

  // open when left out; written in the insert, so the imp never exists
  // without its policy
  readonly egress?: EgressPolicy;
  readonly cpu?: CpuSettings;
  readonly isIdentityResetPending?: boolean;

  // true when left out: every backup run holds the imp
  readonly isBackedUp?: boolean;

  // the networks it joins, in the insert's transaction: its first firewall
  // has them
  readonly networkIds?: readonly string[];

  // a move stages the imp marked
  readonly moveState?: MoveState;

  // user when left out
  readonly kind?: ImpKind;
}

// The uids jailed Firecrackers run as, one per imp, gid the same: far above
// any account in the host image, and kept for the imp's life
export const JAIL_UIDS = { first: 900_000, count: 65_536 } as const;

// what every boot template build runs as, one at a time: below the imps'
export const TEMPLATE_BUILD_UID = JAIL_UIDS.first - 1;

// the lowest free uid of JAIL_UIDS; a destroyed imp's uid goes back
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

// the insert alone; the caller emits once the row is committed
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

  const match = isUnique ? /\bimps\.(?<column>\w+)/v.exec(readErrorMessage(error)) : null;
  const column = match?.groups?.['column'];

  return column === undefined ? null : new ImpClashError(column);
}

interface FreeSlots {
  readonly count: number;
  readonly findIp: (slot: number) => string;

  // a warm move's: this slot or none
  readonly slot?: number | undefined;

  // when a ticket's start window ends against
  readonly now?: () => number;
}

// A `creating` record in the lowest free slot, or the one asked for: the
// slot and the insert share one transaction, and the write is reported once
// it commits.
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

export async function findImpByName(db: ImpDatabase, name: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function findImpById(db: ImpDatabase, id: string): Promise<ImpRecord | undefined> {
  const row = await db.selectFrom('imps').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImpRecord(row);
}

export async function listImps(db: ImpDatabase): Promise<ImpRecord[]> {
  const rows = await db.selectFrom('imps').selectAll().orderBy('name').execute();

  return rows.map((row) => toImpRecord(row));
}

// imps by state; a state no imp is in is absent
export async function countImpsByState(db: ImpDatabase): Promise<Map<ImpState, number>> {
  const rows = await db
    .selectFrom('imps')
    .select((eb) => ['state', eb.fn.countAll<number>().as('count')])
    .groupBy('state')
    .execute();

  return new Map(rows.map((row) => [row.state, row.count]));
}

// what imps.update changes; the caller applies a new CPU limit or weight
// to a running VM
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

// A move's commit on the target: the mark off and the tickets committed in
// one transaction, so no crash leaves one without the other
export async function updateImpCommitted(
  db: ImpDatabase,
  id: string,
  committedAt: number,
  isWarm = false,
): Promise<ImpRecord> {
  const row = await db.transaction().execute(async (trx) => {
    // a warm move's imp sleeps on the memory it brought, along the lifecycle
    // table's stopped → sleeping, and its first wake installs this host's
    // broker CA
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

// true once, for an imp whose CA install a warm move left to its first wake
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

// Sets or clears the move mark (moves/); the change goes out as `updated`.
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

    // a write that keeps the mark is no move: an abort's clear may find none
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

// the disk's size, and whether a sleeping guest still has to grow into it
export async function updateImpDisk(
  db: ImpDatabase,
  id: string,
  disk: Readonly<{ diskBytes: number; isGrowPending: boolean }>,
): Promise<ImpRecord> {
  const before = await findImpById(db, id);

  const row = await db
    .updateTable('imps')
    .set({ disk_bytes: disk.diskBytes, disk_grow_pending: disk.isGrowPending ? 1 : 0 })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  const sized = toImpRecord(row);

  // the API shows the size, not a grow the guest owes
  if (before?.diskBytes !== sized.diskBytes) {
    db.writes.publish({ kind: 'changed', imp: sized, reason: 'resized' });
  }

  return sized;
}

// A lease with no end counts as one that ends at the last time a Date holds.
const NO_END_MS = 8_640_000_000_000_000;

// hold_until becomes the latest end of the imp's leases (db/leases.ts), so
// the governor, the idle loop and the sleep checks read one field; run it
// in the lease write's transaction
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

// A public imp's auth as stored: the hash of the token or password, never
// the credential itself
export interface StoredPublicAuth {
  readonly auth: PublicAuth;
  readonly user: string | null;
  readonly hash: string | null;
}

// public with this auth, or tailnet-only for null; undefined, and no change,
// for an imp a move marked (docs/guides/hosts.md#moves)
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

// cascades to the imp's checkpoints
export async function removeImp(db: ImpDatabase, id: string): Promise<boolean> {
  const row = await db.deleteFrom('imps').where('id', '=', id).returningAll().executeTakeFirst();

  if (row === undefined) {
    return false;
  }

  db.writes.publish({ kind: 'removed', imp: toImpRecord(row) });

  return true;
}

// after the first cold boot of an imp from a template
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
