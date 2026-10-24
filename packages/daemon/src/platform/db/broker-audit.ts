import type { AuditEntry, AuditRefusal, RefusedRequest } from '@impz/api';
import type { ImpDatabase } from './open-database';
import { toLikePattern } from './to-like-pattern';

/* @internal */
export const AUDIT_ROWS_PER_IMP = 1000;

/* @internal */
export const AUDIT_ROWS = 100_000;

export interface NewAuditEntry {
  readonly impId: string;

  readonly impName: string;
  readonly secretName: string | null;
  readonly at: Date;
  readonly method: string | null;
  readonly host: string | null;
  readonly path: string | null;
  readonly status: number;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly durationMs: number;
  readonly reason: AuditRefusal | null;
}

export async function writeAuditEntry(db: ImpDatabase, entry: NewAuditEntry): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto('broker_audit')
      .values({
        imp_id: entry.impId,
        imp_name: entry.impName,
        secret_name: entry.secretName,
        at: entry.at.getTime(),
        method: entry.method,
        host: entry.host,
        path: entry.path,
        status: entry.status,
        request_bytes: entry.requestBytes,
        response_bytes: entry.responseBytes,
        duration_ms: entry.durationMs,
        reason: entry.reason,
      })
      .execute();

    const sameKind = entry.reason === null ? 'is' : 'is not';

    const cut = await trx
      .selectFrom('broker_audit')
      .select('id')
      .where('imp_id', '=', entry.impId)
      .where('reason', sameKind, null)
      .orderBy('id', 'desc')
      .offset(AUDIT_ROWS_PER_IMP)
      .limit(1)
      .executeTakeFirst();

    if (cut !== undefined) {
      await trx
        .deleteFrom('broker_audit')
        .where('imp_id', '=', entry.impId)
        .where('reason', sameKind, null)
        .where('id', '<=', cut.id)
        .execute();
    }

    const oldest = await trx
      .selectFrom('broker_audit')
      .select('id')
      .orderBy('id', 'desc')
      .offset(AUDIT_ROWS)
      .limit(1)
      .executeTakeFirst();

    if (oldest !== undefined) {
      await trx.deleteFrom('broker_audit').where('id', '<=', oldest.id).execute();
    }
  });
}

export async function listAuditEntries(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
  patterns: readonly string[] | null,
): Promise<AuditEntry[]> {
  const rows = await listAuditRows(db, { impId, limit, patterns, refused: false });

  return rows.map((row) => {
    if (row.secret_name === null || row.method === null || row.host === null || row.path === null) {
      throw new Error(`broker audit row ${String(row.id)} was sent but lacks a field`);
    }

    return {
      at: new Date(row.at),
      imp: row.imp_name,
      secret: row.secret_name,
      method: row.method,
      host: row.host,
      path: row.path,
      status: row.status,
      requestBytes: row.request_bytes,
      responseBytes: row.response_bytes,
      durationMs: row.duration_ms,
    };
  });
}

export async function listRefusedRequests(
  db: ImpDatabase,
  impId: string | null,
  limit: number,
  patterns: readonly string[] | null,
): Promise<RefusedRequest[]> {
  const rows = await listAuditRows(db, { impId, limit, patterns, refused: true });

  return rows.map((row) => {
    if (row.reason === null) {
      throw new Error(`broker audit row ${String(row.id)} was refused but has no reason`);
    }

    return {
      at: new Date(row.at),
      imp: row.imp_name,
      method: row.method,
      host: row.host,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      reason: row.reason,
    };
  });
}

interface AuditRowFilter {
  readonly impId: string | null;
  readonly limit: number;
  readonly patterns: readonly string[] | null;
  readonly refused: boolean;
}

function listAuditRows(db: ImpDatabase, filter: Readonly<AuditRowFilter>) {
  const kind = filter.refused ? 'is not' : 'is';

  const base = db
    .selectFrom('broker_audit')
    .selectAll()
    .where('reason', kind, null)
    .orderBy('id', 'desc')
    .limit(filter.limit);

  const named = filter.impId === null ? base : base.where('imp_id', '=', filter.impId);
  const patterns = filter.patterns;

  return (
    patterns === null
      ? named
      : named.where((eb) =>
          eb.or(patterns.map((pattern) => eb('imp_name', 'like', toLikePattern(pattern)))),
        )
  ).execute();
}
