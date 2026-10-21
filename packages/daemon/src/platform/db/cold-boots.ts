import type { ColdBoot, ColdBootCause } from '@impz/api';
import type { Transaction } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';

const KEPT_BOOTS = 4;

interface BootRecord {
  readonly bootId: string;
  readonly cause: ColdBootCause;
  readonly at: Date;
}

export async function writeColdBoot(
  db: ImpDatabase,
  impId: string,
  boot: Readonly<BootRecord>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom('imps')
      .select('next_boot_cause')
      .where('id', '=', impId)
      .executeTakeFirst();

    const pending = row?.next_boot_cause ?? null;

    await writeBootRow(trx, impId, {
      ...boot,
      cause: boot.cause === 'start' && pending !== null ? pending : boot.cause,
    });

    await trx.updateTable('imps').set({ next_boot_cause: null }).where('id', '=', impId).execute();
  });
}

export async function writeUnknownBoot(
  db: ImpDatabase,
  impId: string,
  bootId: string,
  at: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await writeBootRow(trx, impId, { bootId, cause: 'unknown', at });
  });
}

export async function writeMovedBoots(
  db: ImpDatabase,
  impId: string,
  boots: readonly Readonly<ColdBoot>[],
  now: number,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const boot of boots.toReversed()) {
      const at = Math.min(Date.parse(boot.at), now);

      await writeBootRow(trx, impId, { ...boot, at: new Date(at) });
    }
  });
}

export async function writeNextBootCause(
  db: ImpDatabase,
  impId: string,
  cause: Extract<ColdBootCause, 'recovery' | 'restore'>,
): Promise<void> {
  await db.updateTable('imps').set({ next_boot_cause: cause }).where('id', '=', impId).execute();
}

export async function removeNextBootCause(db: ImpDatabase, impId: string): Promise<void> {
  await db.updateTable('imps').set({ next_boot_cause: null }).where('id', '=', impId).execute();
}

export async function listColdBoots(db: ImpDatabase, impId: string): Promise<ColdBoot[]> {
  const rows = await db
    .selectFrom('imp_cold_boots')
    .selectAll()
    .where('imp_id', '=', impId)
    .orderBy('seq', 'desc')
    .limit(KEPT_BOOTS)
    .execute();

  return rows.map((row) => ({
    bootId: row.boot_id,
    cause: row.cause,
    at: new Date(row.at).toISOString(),
  }));
}

async function writeBootRow(
  trx: Transaction<DB>,
  impId: string,
  boot: Readonly<BootRecord>,
): Promise<void> {
  await trx
    .insertInto('imp_cold_boots')
    .values({ imp_id: impId, boot_id: boot.bootId, cause: boot.cause, at: boot.at.getTime() })
    .onConflict((conflict) => conflict.columns(['imp_id', 'boot_id']).doNothing())
    .execute();

  const kept = trx
    .selectFrom('imp_cold_boots')
    .select('boot_id')
    .where('imp_id', '=', impId)
    .orderBy('seq', 'desc')
    .limit(KEPT_BOOTS);

  await trx
    .deleteFrom('imp_cold_boots')
    .where('imp_id', '=', impId)
    .where('boot_id', 'not in', kept)
    .execute();
}
