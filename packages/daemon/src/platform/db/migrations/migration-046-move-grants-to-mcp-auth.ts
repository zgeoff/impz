import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Migration } from 'kysely/migration';
import type { NoTables } from './no-tables';

// better-auth writes each time as ISO 8601 text in UTC with milliseconds, so the text compares in
// time order.
const NOW = sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// Each grant already has its own user row, with its tokens and sessions cascading from it. The
// shared OAuth server reads the client, the scopes, the approver and the limits from that row.
const STATEMENTS = [
  sql`CREATE TEMP TABLE imp_grant_token AS
    SELECT userId, clientId, scopes, createdAt, expiresAt, revoked FROM oauthRefreshToken
    UNION ALL
    SELECT userId, clientId, scopes, createdAt, expiresAt, revoked FROM oauthAccessToken
      WHERE userId IS NOT NULL`,

  // A grant with no live token has ended, and a sign-in that never issued one ends at a restart.
  sql`DELETE FROM "user" WHERE id NOT IN (
    SELECT userId FROM imp_grant_token WHERE revoked IS NULL AND expiresAt > ${NOW}
  )`,

  sql`ALTER TABLE "user" ADD COLUMN "clientId" text`,
  sql`ALTER TABLE "user" ADD COLUMN "scopes" text`,
  sql`ALTER TABLE "user" ADD COLUMN "approvedBy" text`,
  sql`ALTER TABLE "user" ADD COLUMN "limits" text`,

  // With max(), SQLite takes the other bare columns from the row that holds the maximum, so each
  // grant takes the client and scopes of its newest live token.
  sql`UPDATE "user" SET
    "clientId" = live.clientId,
    "scopes" = (SELECT json_group_array(scope.value) FROM json_each(live.scopes) AS scope
      WHERE scope.value <> 'offline_access'),
    "approvedBy" = 'token:' || "user"."tokenId",
    "limits" = json_object(
      'imps', json("user"."imps"),
      'grantable', json(CASE
        WHEN coalesce(
          (SELECT json_array_length(approver.grantable) FROM tokens AS approver
            WHERE approver.id = "user"."tokenId"),
          0
        ) > 0 THEN 'true'
        ELSE 'false'
      END)
    )
    FROM (
      SELECT userId, clientId, scopes, max(createdAt) AS newestAt FROM imp_grant_token
        WHERE revoked IS NULL AND expiresAt > ${NOW}
        GROUP BY userId
    ) AS live
    WHERE live.userId = "user"."id"`,

  // ALTER TABLE rewrites the table in place: a DROP TABLE with foreign keys on would cascade to
  // every token.
  sql`ALTER TABLE "user" DROP COLUMN "tokenId"`,
  sql`ALTER TABLE "user" DROP COLUMN "imps"`,
  sql`DROP TABLE temp.imp_grant_token`,
];

export const MIGRATION_046_MOVE_GRANTS_TO_MCP_AUTH: Migration = {
  async up(db: Kysely<NoTables>) {
    await db.transaction().execute(async (trx) => {
      for (const statement of STATEMENTS) {
        await statement.execute(trx);
      }

      const broken = await sql`PRAGMA foreign_key_check`.execute(trx);

      if (broken.rows.length > 0) {
        throw new Error(
          `the grant migration left ${String(broken.rows.length)} rows whose foreign key points at no row`,
        );
      }
    });
  },
};
