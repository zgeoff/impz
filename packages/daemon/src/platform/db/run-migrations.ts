import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Migration, MigrationProvider, MigrationResultSet } from 'kysely/migration';
import { MIGRATION_001_CREATE_INITIAL_SCHEMA } from './migrations/migration-001-create-initial-schema';
import { MIGRATION_002_ADD_IMP_HTTP_PORT } from './migrations/migration-002-add-imp-http-port';
import { MIGRATION_003_ADD_BROKER } from './migrations/migration-003-add-broker';
import { MIGRATION_004_ADD_API_AUDIT } from './migrations/migration-004-add-api-audit';
import { MIGRATION_005_ADD_DISK_SIZES } from './migrations/migration-005-add-disk-sizes';
import { MIGRATION_006_ADD_TOKENS } from './migrations/migration-006-add-tokens';
import { MIGRATION_007_ADD_EGRESS_ALLOW } from './migrations/migration-007-add-egress-allow';
import { MIGRATION_008_ADD_TOKEN_SSH_KEYS } from './migrations/migration-008-add-token-ssh-keys';
import { MIGRATION_009_ADD_IMP_CPU } from './migrations/migration-009-add-imp-cpu';
import { MIGRATION_010_ADD_IMAGE_SOURCE } from './migrations/migration-010-add-image-source';
import { MIGRATION_011_ADD_PUBLIC_EXPOSURE } from './migrations/migration-011-add-public-exposure';
import { MIGRATION_012_ADD_NETWORKS } from './migrations/migration-012-add-networks';
import { MIGRATION_013_ADD_IMP_LEASES } from './migrations/migration-013-add-imp-leases';
import { MIGRATION_014_ADD_MOVES } from './migrations/migration-014-add-moves';
import { MIGRATION_015_ADD_COLD_BOOTS } from './migrations/migration-015-add-cold-boots';
import { MIGRATION_016_ADD_IMP_JAIL_UID } from './migrations/migration-016-add-imp-jail-uid';
import { MIGRATION_017_ADD_MOVE_SLOTS } from './migrations/migration-017-add-move-slots';
import { MIGRATION_018_ADD_WARM_MOVES } from './migrations/migration-018-add-warm-moves';
import { MIGRATION_019_ADD_IMP_MAX_MEMORY } from './migrations/migration-019-add-imp-max-memory';
import { MIGRATION_020_ADD_GRANTABLE_SECRETS } from './migrations/migration-020-add-grantable-secrets';
import { MIGRATION_021_ADD_BROKER_SESSIONS } from './migrations/migration-021-add-broker-sessions';
import { MIGRATION_022_ADD_MCP_OAUTH } from './migrations/migration-022-add-mcp-oauth';
import { MIGRATION_023_ADD_SECRET_FILE_REMOVALS } from './migrations/migration-023-add-secret-file-removals';
import { MIGRATION_024_ADD_IMP_KIND } from './migrations/migration-024-add-imp-kind';
import { MIGRATION_025_ADD_API_AUDIT_DETAIL } from './migrations/migration-025-add-api-audit-detail';
import { MIGRATION_026_ADD_SECRET_OAUTH } from './migrations/migration-026-add-secret-oauth';
import { MIGRATION_027_ADD_IMP_BACKUP } from './migrations/migration-027-add-imp-backup';
import { MIGRATION_028_CASCADE_OAUTH_TOKENS } from './migrations/migration-028-cascade-oauth-tokens';
import { MIGRATION_029_ADD_TOKEN_IMAGE_REF_PREFIX } from './migrations/migration-029-add-token-image-ref-prefix';
import { MIGRATION_030_ADD_BROKER_AUDIT_REFUSALS } from './migrations/migration-030-add-broker-audit-refusals';
import { MIGRATION_031_ADD_GRANT_FILTER } from './migrations/migration-031-add-grant-filter';
import { MIGRATION_032_ADD_IMP_OOPS_BOOT_ID } from './migrations/migration-032-add-imp-oops-boot-id';
import { MIGRATION_033_ADD_IMP_OOPS_HOLD } from './migrations/migration-033-add-imp-oops-hold';
import { MIGRATION_034_ADD_BETTER_AUTH } from './migrations/migration-034-add-better-auth';
import { MIGRATION_035_DROP_OLD_OAUTH } from './migrations/migration-035-drop-old-oauth';
import { MIGRATION_036_KEEP_BROKER_AUDIT_OF_DESTROYED_IMPS } from './migrations/migration-036-keep-broker-audit-of-destroyed-imps';
import { MIGRATION_037_ADD_IMAGE_LAST_USED } from './migrations/migration-037-add-image-last-used';
import { MIGRATION_038_ADD_IMAGE_REMOVALS } from './migrations/migration-038-add-image-removals';
import { MIGRATION_039_ADD_IMAGE_PINS } from './migrations/migration-039-add-image-pins';

export const MIGRATIONS: Record<string, Migration> = {
  '001_create_initial_schema': MIGRATION_001_CREATE_INITIAL_SCHEMA,
  '002_add_imp_http_port': MIGRATION_002_ADD_IMP_HTTP_PORT,
  '003_add_broker': MIGRATION_003_ADD_BROKER,
  '004_add_api_audit': MIGRATION_004_ADD_API_AUDIT,
  '005_add_disk_sizes': MIGRATION_005_ADD_DISK_SIZES,
  '006_add_tokens': MIGRATION_006_ADD_TOKENS,
  '007_add_egress_allow': MIGRATION_007_ADD_EGRESS_ALLOW,
  '008_add_token_ssh_keys': MIGRATION_008_ADD_TOKEN_SSH_KEYS,
  '009_add_imp_cpu': MIGRATION_009_ADD_IMP_CPU,
  '010_add_image_source': MIGRATION_010_ADD_IMAGE_SOURCE,
  '011_add_public_exposure': MIGRATION_011_ADD_PUBLIC_EXPOSURE,
  '012_add_networks': MIGRATION_012_ADD_NETWORKS,
  '013_add_imp_leases': MIGRATION_013_ADD_IMP_LEASES,
  '014_add_moves': MIGRATION_014_ADD_MOVES,
  '015_add_cold_boots': MIGRATION_015_ADD_COLD_BOOTS,
  '016_add_imp_jail_uid': MIGRATION_016_ADD_IMP_JAIL_UID,
  '017_add_move_slots': MIGRATION_017_ADD_MOVE_SLOTS,
  '018_add_warm_moves': MIGRATION_018_ADD_WARM_MOVES,
  '019_add_imp_max_memory': MIGRATION_019_ADD_IMP_MAX_MEMORY,
  '020_add_grantable_secrets': MIGRATION_020_ADD_GRANTABLE_SECRETS,
  '021_add_broker_sessions': MIGRATION_021_ADD_BROKER_SESSIONS,
  '022_add_mcp_oauth': MIGRATION_022_ADD_MCP_OAUTH,
  '023_add_secret_file_removals': MIGRATION_023_ADD_SECRET_FILE_REMOVALS,
  '024_add_imp_kind': MIGRATION_024_ADD_IMP_KIND,
  '025_add_api_audit_detail': MIGRATION_025_ADD_API_AUDIT_DETAIL,
  '026_add_secret_oauth': MIGRATION_026_ADD_SECRET_OAUTH,
  '027_add_imp_backup': MIGRATION_027_ADD_IMP_BACKUP,
  '028_cascade_oauth_tokens': MIGRATION_028_CASCADE_OAUTH_TOKENS,
  '029_add_token_image_ref_prefix': MIGRATION_029_ADD_TOKEN_IMAGE_REF_PREFIX,
  '030_add_broker_audit_refusals': MIGRATION_030_ADD_BROKER_AUDIT_REFUSALS,
  '031_add_grant_filter': MIGRATION_031_ADD_GRANT_FILTER,
  '032_add_imp_oops_boot_id': MIGRATION_032_ADD_IMP_OOPS_BOOT_ID,
  '033_add_imp_oops_hold': MIGRATION_033_ADD_IMP_OOPS_HOLD,
  '034_add_better_auth': MIGRATION_034_ADD_BETTER_AUTH,
  '035_drop_old_oauth': MIGRATION_035_DROP_OLD_OAUTH,
  '036_keep_broker_audit_of_destroyed_imps': MIGRATION_036_KEEP_BROKER_AUDIT_OF_DESTROYED_IMPS,
  '037_add_image_last_used': MIGRATION_037_ADD_IMAGE_LAST_USED,
  '038_add_image_removals': MIGRATION_038_ADD_IMAGE_REMOVALS,
  '039_add_image_pins': MIGRATION_039_ADD_IMAGE_PINS,
};

const PROVIDER: MigrationProvider = {
  getMigrations: () => Promise.resolve(MIGRATIONS),
};

export async function runMigrations<T>(db: Kysely<T>): Promise<void> {
  await requireKnownMigrations(db);

  const migrator = new Migrator({ db, provider: PROVIDER });

  const result = await migrator.migrateToLatest();

  requireMigrated(result);
}

/* @internal */
export async function runMigrationsTo<T>(
  db: Kysely<T>,
  name: string,
  migrations: Readonly<Record<string, Readonly<Migration>>> = MIGRATIONS,
): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: { getMigrations: () => Promise.resolve({ ...migrations }) },
  });

  const result = await migrator.migrateTo(name);

  requireMigrated(result);
}

// Kysely's own refusal names only the missing migration, not both schema
// versions.
async function requireKnownMigrations<T>(db: Kysely<T>): Promise<void> {
  const table = await sql<{ name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kysely_migration'
  `.execute(db);

  if (table.rows.length === 0) {
    return;
  }

  const executed = await sql<{ name: string }>`SELECT name FROM kysely_migration`.execute(db);

  const unknown = executed.rows
    .map((row) => row.name)
    .filter((name) => !Object.hasOwn(MIGRATIONS, name));

  if (unknown.length === 0) {
    return;
  }

  const newest = unknown.toSorted().at(-1) ?? '';
  const known = Object.keys(MIGRATIONS).toSorted().at(-1) ?? '';

  throw new Error(
    `the database is at migration ${newest}, newer than this impd's last, ${known}: start the impd that wrote it or a newer one, or restore an older database copy (docs/guides/operations.md#database-copy-and-restore)`,
  );
}

function requireMigrated(result: MigrationResultSet): void {
  if (result.error === undefined) {
    return;
  }

  if (result.error instanceof Error) {
    throw result.error;
  }

  throw new Error('kysely migration failed', { cause: result.error });
}
