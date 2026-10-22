import { randomBytes } from 'node:crypto';
import {
  BrokerRuleSchema,
  GrantFilterSchema,
  OAuthConfigSchema,
  SecretKindSchema,
} from '@impz/api';
import type { BrokerRule, Grant, GrantFilter, OAuthConfig, SecretKind } from '@impz/api';
import type { Selectable } from 'kysely';
import * as z from 'zod';
import type { ImpDatabase, ImpQueries } from './open-database';
import type { DB } from './schema';
import { readTokenGrantable } from './tokens';

export type SecretRow = Selectable<DB['secrets']>;

export interface SecretRecord {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];

  readonly oauth: OAuthConfig | null;

  readonly generation: string;

  readonly valueFile: string;
  readonly createdAt: Date;
}

export interface NewSecret {
  readonly name: string;
  readonly kind: SecretKind;
  readonly rules: readonly BrokerRule[];

  readonly oauth?: OAuthConfig | null | undefined;

  // written before the row, so a row never names a file that is not there
  readonly valueFile: string;
}

export interface GrantedRule {
  readonly secretName: string;
  readonly kind: SecretKind;
  readonly rule: BrokerRule;
  readonly valueFile: string;

  readonly filter: GrantFilter | null;
}

export interface GrantClash {
  readonly secretName: string;
  readonly host: string;
}

export interface GrantAuthority {
  readonly tokenId: string;
  readonly generation: string;
}

export type GrantOutcome =
  | { readonly kind: 'granted' }
  | { readonly kind: 'no-secret' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'not-grantable' }
  | { readonly kind: 'clash'; readonly clash: GrantClash };

export type RevokeOutcome =
  | { readonly kind: 'revoked' }
  | { readonly kind: 'no-grant' }
  | { readonly kind: 'no-token' }
  | { readonly kind: 'not-grantable' };

export type ReplaceOutcome =
  | {
      readonly kind: 'saved';
      readonly secret: SecretRecord;
      readonly oldValueFile: string | null;
      readonly droppedGrants: number;
    }
  | { readonly kind: 'binding-changed' };

const RulesSchema = z.array(BrokerRuleSchema);

export async function createSecret(
  db: ImpQueries,
  secret: Readonly<NewSecret>,
): Promise<SecretRecord | null> {
  const row = await db
    .insertInto('secrets')
    .values({
      name: secret.name,
      kind: secret.kind,
      rules: JSON.stringify(secret.rules),
      oauth: formatOAuthConfig(secret.oauth),
      generation: createGeneration(),
      value_file: secret.valueFile,
      created_at: Date.now(),
    })
    .onConflict((conflict) => conflict.column('name').doNothing())
    .returningAll()
    .executeTakeFirst();

  return row === undefined ? null : toSecretRecord(row);
}

export function listSecretRows(db: ImpDatabase): Promise<SecretRow[]> {
  return db.selectFrom('secrets').selectAll().orderBy('name').execute();
}

export function upsertSecret(
  db: ImpDatabase,
  secret: Readonly<NewSecret>,
  rebind: boolean,
): Promise<ReplaceOutcome> {
  return db.transaction().execute(async (trx) => {
    const existing = await readSecret(trx, secret.name);

    if (existing === undefined) {
      const made = await createSecret(trx, secret);

      if (made === null) {
        throw new Error(`secret ${secret.name} was not saved`);
      }

      return { kind: 'saved', secret: made, oldValueFile: null, droppedGrants: 0 };
    }

    const isRotation = isSameBinding(existing, secret);

    if (!isRotation && !rebind) {
      return { kind: 'binding-changed' };
    }

    const dropped = isRotation
      ? null
      : await trx.deleteFrom('grants').where('secret_name', '=', secret.name).executeTakeFirst();

    const row = await trx
      .updateTable('secrets')
      .set({
        kind: secret.kind,
        rules: JSON.stringify(secret.rules),
        oauth: formatOAuthConfig(secret.oauth),
        value_file: secret.valueFile,
        ...(!isRotation && { generation: createGeneration() }),
      })
      .where('name', '=', secret.name)
      .returningAll()
      .executeTakeFirstOrThrow();

    await createFileRemoval(trx, existing.valueFile);

    return {
      kind: 'saved',
      secret: toSecretRecord(row),
      oldValueFile: existing.valueFile,
      droppedGrants: Number(dropped?.numDeletedRows ?? 0n),
    };
  });
}

export async function readSecret(db: ImpQueries, name: string): Promise<SecretRecord | undefined> {
  const row = await db
    .selectFrom('secrets')
    .selectAll()
    .where('name', '=', name)
    .executeTakeFirst();

  return row === undefined ? undefined : toSecretRecord(row);
}

export async function listSecrets(
  db: ImpDatabase,
): Promise<{ readonly secret: SecretRecord; readonly imps: readonly string[] }[]> {
  const rows = await db.selectFrom('secrets').selectAll().orderBy('name').execute();

  const grants = await useLiveGrants(db)
    .innerJoin('imps', 'imps.id', 'grants.imp_id')
    .select(['grants.secret_name', 'imps.name'])
    .orderBy('imps.name')
    .execute();

  return rows.map((row) => ({
    secret: toSecretRecord(row),
    imps: grants.filter((grant) => grant.secret_name === row.name).map((grant) => grant.name),
  }));
}

export function removeSecret(db: ImpDatabase, name: string): Promise<string | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom('secrets')
      .where('name', '=', name)
      .returning('value_file')
      .executeTakeFirst();

    if (row === undefined) {
      return null;
    }

    await createFileRemoval(trx, row.value_file);

    return row.value_file;
  });
}

async function createFileRemoval(db: ImpQueries, valueFile: string): Promise<void> {
  await db
    .insertInto('secret_file_removals')
    .values({ value_file: valueFile, created_at: Date.now() })
    .onConflict((conflict) => conflict.column('value_file').doNothing())
    .execute();
}

export async function listFileRemovals(db: ImpDatabase): Promise<string[]> {
  const rows = await db.selectFrom('secret_file_removals').select('value_file').execute();

  return rows.map((row) => row.value_file);
}

export async function removeFileRemoval(db: ImpDatabase, valueFile: string): Promise<void> {
  await db.deleteFrom('secret_file_removals').where('value_file', '=', valueFile).execute();
}

export interface CreateCheckedGrantOptions {
  readonly impId: string;
  readonly secretName: string;
  readonly authority: Readonly<GrantAuthority> | null;
  readonly filter?: GrantFilter | undefined;
}

export function createCheckedGrant(
  db: ImpDatabase,
  options: CreateCheckedGrantOptions,
): Promise<GrantOutcome> {
  const impId = options.impId;

  return db.transaction().execute(async (trx) => {
    const secret = await readSecret(trx, options.secretName);
    const refusal = await checkAuthority(trx, options.authority, secret);

    if (refusal !== null) {
      return { kind: refusal };
    }

    if (secret === undefined) {
      return { kind: 'no-secret' };
    }

    const clash = await readClash(trx, impId, secret.name, secret.rules);

    if (clash !== null) {
      return { kind: 'clash', clash };
    }

    await writeGrant(trx, impId, secret, options.filter);

    return { kind: 'granted' };
  });
}

export function removeCheckedGrant(
  db: ImpDatabase,
  impId: string,
  secretName: string,
  authority: Readonly<GrantAuthority> | null,
): Promise<RevokeOutcome> {
  return db.transaction().execute(async (trx) => {
    const secret = await readSecret(trx, secretName);
    const refusal = await checkAuthority(trx, authority, secret);

    if (refusal !== null) {
      return { kind: refusal };
    }

    const result = await trx
      .deleteFrom('grants')
      .where('imp_id', '=', impId)
      .where('secret_name', '=', secretName)
      .executeTakeFirst();

    return result.numDeletedRows > 0n ? { kind: 'revoked' } : { kind: 'no-grant' };
  });
}

export async function listGrantNames(db: ImpQueries, impId: string): Promise<string[]> {
  const rows = await useLiveGrants(db)
    .select('grants.secret_name')
    .where('grants.imp_id', '=', impId)
    .orderBy('grants.secret_name')
    .execute();

  return rows.map((row) => row.secret_name);
}

export async function listGrants(db: ImpQueries, impId: string): Promise<Grant[]> {
  const rows = await useLiveGrants(db)
    .select(['grants.secret_name', 'grants.filter'])
    .where('grants.imp_id', '=', impId)
    .orderBy('grants.secret_name')
    .execute();

  return rows.map((row) => ({ secret: row.secret_name, filter: parseFilter(row.filter) }));
}

export async function listValueFiles(db: ImpDatabase): Promise<Set<string>> {
  const rows = await db.selectFrom('secrets').select('value_file').execute();

  return new Set(rows.map((row) => row.value_file));
}

export async function listGrantedRules(db: ImpQueries, impId: string): Promise<GrantedRule[]> {
  const rows = await useLiveGrants(db)
    .select([
      'secrets.name',
      'secrets.kind',
      'secrets.rules',
      'secrets.value_file',
      'grants.filter',
    ])
    .where('grants.imp_id', '=', impId)
    .orderBy('secrets.name')
    .execute();

  return rows.flatMap((row) =>
    parseRules(row.rules).map((rule) => ({
      secretName: row.name,
      kind: parseKind(row.kind),
      rule,
      valueFile: row.value_file,
      filter: parseFilter(row.filter),
    })),
  );
}

export async function listAllGrantedRules(
  db: ImpDatabase,
): Promise<{ readonly impId: string; readonly rule: BrokerRule }[]> {
  const rows = await useLiveGrants(db).select(['grants.imp_id', 'secrets.rules']).execute();

  return rows.flatMap((row) => parseRules(row.rules).map((rule) => ({ impId: row.imp_id, rule })));
}

// A host has one credential per imp: two would leave the header ambiguous.
export async function readClash(
  db: ImpQueries,
  impId: string,
  secretName: string,
  rules: readonly BrokerRule[],
): Promise<GrantClash | null> {
  const granted = await listGrantedRules(db, impId);

  const clash = granted.find(
    (other) =>
      other.secretName !== secretName && rules.some((rule) => rule.host === other.rule.host),
  );

  return clash === undefined ? null : { secretName: clash.secretName, host: clash.rule.host };
}

function useLiveGrants(db: ImpQueries) {
  return db
    .selectFrom('grants')
    .innerJoin('secrets', (join) =>
      join
        .onRef('secrets.name', '=', 'grants.secret_name')
        .onRef('secrets.generation', '=', 'grants.secret_generation'),
    );
}

// The token may have been removed, or the secret deleted or rebound, since
// the access check.
async function checkAuthority(
  db: ImpQueries,
  authority: Readonly<GrantAuthority> | null,
  secret: Readonly<SecretRecord> | undefined,
): Promise<'no-token' | 'not-grantable' | null> {
  if (authority === null) {
    return null;
  }

  const grantable = await readTokenGrantable(db, authority.tokenId);

  if (grantable === null) {
    return 'no-token';
  }

  const listed = grantable.some(
    (entry) => entry.name === secret?.name && entry.generation === authority.generation,
  );

  return listed && secret?.generation === authority.generation ? null : 'not-grantable';
}

export async function writeGrant(
  db: ImpQueries,
  impId: string,
  secret: Readonly<SecretRecord>,
  filter: GrantFilter | undefined,
): Promise<void> {
  const stored = filter === undefined ? null : JSON.stringify(filter);

  await db
    .insertInto('grants')
    .values({
      imp_id: impId,
      secret_name: secret.name,
      secret_generation: secret.generation,
      filter: stored,
    })
    .onConflict((conflict) =>
      conflict.columns(['imp_id', 'secret_name']).doUpdateSet({
        secret_generation: secret.generation,
        ...(filter !== undefined && { filter: stored }),
      }),
    )
    .execute();
}

function createGeneration(): string {
  return randomBytes(16).toString('hex');
}

function isSameBinding(
  left: Readonly<Pick<NewSecret, 'kind' | 'rules' | 'oauth'>>,
  right: Readonly<Pick<NewSecret, 'kind' | 'rules' | 'oauth'>>,
): boolean {
  return (
    left.kind === right.kind &&
    toBindingKey(left.rules) === toBindingKey(right.rules) &&
    formatOAuthConfig(left.oauth) === formatOAuthConfig(right.oauth)
  );
}

function formatOAuthConfig(oauth: Readonly<OAuthConfig> | null | undefined): string | null {
  return oauth === null || oauth === undefined
    ? null
    : JSON.stringify({
        tokenUrl: oauth.tokenUrl,
        clientId: oauth.clientId,
        tokenFormat: oauth.tokenFormat,
      });
}

function parseOAuth(json: string | null): OAuthConfig | null {
  return json === null ? null : OAuthConfigSchema.parse(JSON.parse(json));
}

function toBindingKey(rules: readonly BrokerRule[]): string {
  const canonical = rules
    .map(
      (rule) =>
        [
          rule.host,
          rule.header.toLowerCase(),
          rule.scheme,
          rule.user ?? null,
          rule.upstream ?? null,
        ] as const,
    )
    .toSorted((x, y) => `${x[0]}\n${x[1]}`.localeCompare(`${y[0]}\n${y[1]}`));

  return JSON.stringify(canonical);
}

function toSecretRecord(row: Readonly<SecretRow>): SecretRecord {
  return {
    name: row.name,
    kind: parseKind(row.kind),
    rules: parseRules(row.rules),
    oauth: parseOAuth(row.oauth),
    generation: row.generation,
    valueFile: row.value_file,
    createdAt: new Date(row.created_at),
  };
}

function parseRules(json: string): BrokerRule[] {
  return RulesSchema.parse(JSON.parse(json));
}

function parseFilter(json: string | null): GrantFilter | null {
  return json === null ? null : GrantFilterSchema.parse(JSON.parse(json));
}

function parseKind(kind: string): SecretKind {
  return SecretKindSchema.parse(kind);
}
