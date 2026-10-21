import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { buildMockNewAuditEntry } from '../../../testing/platform/build-mock-new-audit-entry';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { AUDIT_ROWS, listAuditEntries, writeAuditEntry } from './broker-audit';

test('#writeAuditEntry keeps every row while the table is under its cap, however far apart their ids', async () => {
  const ctx = await createTestDatabase();

  await sql`INSERT INTO broker_audit (id, imp_id, imp_name, secret_name, at, method, host, path,
    status, request_bytes, response_bytes, duration_ms, reason)
    VALUES (1, 'imp-1', 'ops', 'gh', 1, 'GET', 'api.github.com', '/oldest', 200, 0, 0, 0, NULL),
      (${AUDIT_ROWS}, 'imp-2', 'dev', 'gh', 2, 'GET', 'api.github.com', '/older', 200, 0, 0, 0,
        NULL)`.execute(ctx.db);

  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impName: 'dev', path: '/newest' }));

  const rows = await listAuditEntries(ctx.db, null, 10, null);

  expect(rows.map((row) => row.path)).toStrictEqual(['/newest', '/older', '/oldest']);
});

test('#writeAuditEntry removes the oldest rows across every imp past the table cap', async () => {
  const ctx = await createTestDatabase();

  await sql`WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ${AUDIT_ROWS})
    INSERT INTO broker_audit (id, imp_id, imp_name, secret_name, at, method, host, path, status,
      request_bytes, response_bytes, duration_ms, reason)
    SELECT id, 'gone', 'old', 'gh', id, 'GET', 'api.github.com', '/old', 200, 0, 0, 0, NULL
    FROM n`.execute(ctx.db);

  await writeAuditEntry(ctx.db, buildMockNewAuditEntry({ impName: 'dev', path: '/newest' }));

  const kept = await sql<{ rows: number; oldest: number }>`
    SELECT COUNT(*) AS rows, MIN(id) AS oldest FROM broker_audit
  `.execute(ctx.db);

  expect(kept.rows).toStrictEqual([{ rows: AUDIT_ROWS, oldest: 2 }]);
});
