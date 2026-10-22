import { randomBytes } from 'node:crypto';
import { MAX_SSH_KEYS } from '@impz/api';
import type { Scope, SshKey, Token } from '@impz/api';
import { formatKeyFingerprint, parsePublicKey } from '../../imps/ssh/authorized-keys';
import type { AuthorizedKey } from '../../imps/ssh/authorized-keys';
import type { ImpDatabase, ImpQueries } from '../../platform/db/open-database';
import { readSecret } from '../../platform/db/secrets';
import {
  listTokenRecords,
  listTokenSshKeyRecords,
  removeTokenRecord,
  removeTokenSshKeyRecord,
  updateTokenRecord,
  writeTokenRecord,
  writeTokenSshKeyRecord,
} from '../../platform/db/tokens';
import type { GrantableSecret, TokenRecord, TokenSshKeyRecord } from '../../platform/db/tokens';
import { ImpdError } from '../../platform/errors/impd-error';
import { buildConflictError, buildNotFoundError } from '../../platform/errors/impd-errors';
import { hashSecret } from '../../platform/secrets/hash-secret';
import { isSameDigest } from '../../platform/secrets/is-same-digest';
import { mintOpaqueToken } from '../../platform/secrets/mint-opaque-token';
import { parseOpaqueToken } from '../../platform/secrets/parse-opaque-token';
import type { Caller } from './caller';

// A made token's id is 16 characters, so this one never clashes with it.
export const ROOT_TOKEN_ID = 'root';
const ROOT_NAME = 'root';
const ROOT_PRINCIPAL = 'root';
const SECRET_PREFIX = 'imp_';

interface NewToken {
  readonly name: string;
  readonly scope: Scope;
  readonly imps: readonly string[] | null;

  readonly sshKeys?: readonly string[];

  readonly grantable?: readonly string[];

  readonly imageRefPrefix?: string;
}

interface TokenUpdate {
  readonly grantable?: readonly string[];
  readonly imageRefPrefix?: string | null;
}

export interface BoundSshKey {
  readonly key: AuthorizedKey;
  readonly keyId: string;
  readonly caller: Caller;
}

interface KeyEntry {
  readonly record: TokenSshKeyRecord;
  readonly key: AuthorizedKey;
}

interface RestoredTokens {
  readonly restored: readonly string[];
  readonly skipped: readonly { name: string; reason: string }[];
}

export interface TokenStore {
  readonly list: () => Token[];

  readonly create: (token: Readonly<NewToken>) => Promise<{ token: Token; secret: string }>;

  readonly update: (
    name: string,
    change: Readonly<TokenUpdate>,
  ) => Promise<{ token: Token; droppedGrants: number }>;

  readonly remove: (name: string) => Promise<void>;

  readonly addKey: (name: string, line: string) => Promise<SshKey>;

  readonly removeKey: (name: string, fingerprint: string) => Promise<void>;

  readonly findSshKey: (blob: Buffer) => BoundSshKey | null;

  readonly authenticate: (secret: string) => Caller | null;

  readonly findById: (id: string) => Caller | null;

  readonly createRestored: (
    tokens: readonly TokenRecord[],
    keys: readonly TokenSshKeyRecord[],
  ) => Promise<RestoredTokens>;
}

interface TokenStoreDeps {
  readonly db: ImpDatabase;
  readonly rootToken: string;
  readonly now: () => number;

  readonly onRemove: (id: string) => void;

  readonly isFileKey: (blob: Buffer) => boolean;
}

export async function loadTokenStore(deps: Readonly<TokenStoreDeps>): Promise<TokenStore> {
  const byId = new Map<string, TokenRecord>();
  const keysByFingerprint = new Map<string, KeyEntry>();

  for (const record of await listTokenRecords(deps.db)) {
    byId.set(record.id, record);
  }

  for (const record of await listTokenSshKeyRecords(deps.db)) {
    const key = parsePublicKey(record.publicKey);

    if (typeof key !== 'string') {
      keysByFingerprint.set(record.fingerprint, {
        record,
        key: { ...key, comment: record.comment },
      });
    }
  }

  const rootHash = hashSecret(deps.rootToken);

  const rootCaller: Caller = {
    kind: 'token',
    name: ROOT_NAME,
    scope: 'manage',
    imps: null,
    grantable: [],

    imageRefPrefix: null,
    tokenId: ROOT_TOKEN_ID,
    grantId: null,
    expiresAt: null,

    principal: ROOT_PRINCIPAL,
    display: ROOT_NAME,
  };

  const findByName = (name: string): TokenRecord | null =>
    [...byId.values()].find((record) => record.name === name) ?? null;

  const requireByName = (name: string): TokenRecord => {
    const record = findByName(name);

    if (record === null) {
      throw buildNotFoundError('token', name);
    }

    return record;
  };

  const listKeys = (tokenId: string): KeyEntry[] =>
    [...keysByFingerprint.values()].filter((entry) => entry.record.tokenId === tokenId);

  // a key added to the file after it was bound: unbinding it would hand it
  // every imp, so the line goes first
  const requireNotInFile = (entries: readonly KeyEntry[]): void => {
    const listed = entries.find((entry) => deps.isFileKey(entry.key.blob));

    if (listed !== undefined) {
      const fingerprint = listed.record.fingerprint;

      throw buildConflictError(
        'ssh-key',
        fingerprint,
        `key ${fingerprint} is in authorized_keys too, where it has every imp; delete that line, then unbind it`,
      );
    }
  };

  const toFullToken = (record: Readonly<TokenRecord>): Token => ({
    ...toToken(record),
    sshKeys: listKeys(record.id).map((entry) => toSshKey(entry)),
  });

  const buildKeyEntry = (tokenId: string, line: string): KeyEntry => {
    const key = parsePublicKey(line);

    if (typeof key === 'string') {
      throw new ImpdError('BAD_REQUEST', { message: `not an SSH public key: ${key}` });
    }

    const fingerprint = formatKeyFingerprint(key.blob);

    if (keysByFingerprint.has(fingerprint)) {
      throw buildConflictError('ssh-key', fingerprint, `key ${fingerprint} is bound to a token`);
    }

    if (deps.isFileKey(key.blob)) {
      throw buildConflictError(
        'ssh-key',
        fingerprint,
        `key ${fingerprint} is in authorized_keys, where it has every imp; delete that line, then bind it`,
      );
    }

    const record: TokenSshKeyRecord = {
      id: randomBytes(12).toString('base64url'),
      tokenId,
      fingerprint,
      publicKey: `${key.type} ${key.blob.toString('base64')}`,
      comment: key.comment,
      createdAt: new Date(deps.now()),
    };

    return { record, key };
  };

  return {
    list: () =>
      [...byId.values()]
        .map((record) => toFullToken(record))
        .toSorted((left, right) => left.name.localeCompare(right.name)),
    create: async (token) => {
      if (token.name === ROOT_NAME || findByName(token.name) !== null) {
        throw buildConflictError('token', token.name);
      }

      const minted = mintOpaqueToken(SECRET_PREFIX);
      const id = minted.id;
      const entries = buildKeyEntries(token.sshKeys ?? [], (line) => buildKeyEntry(id, line));

      const grantable = await readGrantable(deps.db, token.grantable ?? [], token);

      const imageRefPrefix = token.imageRefPrefix ?? null;

      requireImageScope(imageRefPrefix, token);

      const record: TokenRecord = {
        id,
        name: token.name,
        secretHash: hashSecret(minted.secret).toString('hex'),
        scope: token.scope,
        imps: token.imps,
        grantable,
        imageRefPrefix,
        createdAt: new Date(deps.now()),
      };

      await writeTokenRecord(
        deps.db,
        record,
        entries.map((entry) => entry.record),
      );

      byId.set(id, record);

      for (const entry of entries) {
        keysByFingerprint.set(entry.record.fingerprint, entry);
      }

      return { token: toFullToken(record), secret: minted.text };
    },
    update: async (name, change) => {
      const record = requireByName(name);
      const names = change.grantable;

      if (change.imageRefPrefix !== undefined) {
        requireImageScope(change.imageRefPrefix, record);
      }

      const written = await updateTokenRecord(deps.db, record.id, {
        ...(names !== undefined && { readGrantable: (trx) => readGrantable(trx, names, record) }),
        ...(change.imageRefPrefix !== undefined && { imageRefPrefix: change.imageRefPrefix }),
      });

      if (written === null) {
        throw buildNotFoundError('token', name);
      }

      const updated: TokenRecord = {
        ...record,
        grantable: written.grantable,
        imageRefPrefix: written.imageRefPrefix,
      };

      byId.set(record.id, updated);

      return { token: toFullToken(updated), droppedGrants: written.dropped };
    },
    remove: async (name) => {
      const record = requireByName(name);

      requireNotInFile(listKeys(record.id));

      const grantIds = await removeTokenRecord(deps.db, record.id);

      byId.delete(record.id);

      for (const entry of listKeys(record.id)) {
        keysByFingerprint.delete(entry.record.fingerprint);
      }

      deps.onRemove(record.id);

      for (const grantId of grantIds) {
        deps.onRemove(grantId);
      }
    },
    addKey: async (name, line) => {
      const record = requireByName(name);

      if (listKeys(record.id).length >= MAX_SSH_KEYS) {
        throw new ImpdError('BAD_REQUEST', {
          message: `token ${name} holds ${String(MAX_SSH_KEYS)} keys, the most it may`,
        });
      }

      const entry = buildKeyEntry(record.id, line);

      await writeTokenSshKeyRecord(deps.db, entry.record);

      keysByFingerprint.set(entry.record.fingerprint, entry);

      return toSshKey(entry);
    },
    removeKey: async (name, fingerprint) => {
      const record = requireByName(name);
      const entry = keysByFingerprint.get(fingerprint);

      if (entry === undefined || entry.record.tokenId !== record.id) {
        throw buildNotFoundError('ssh-key', fingerprint);
      }

      requireNotInFile([entry]);

      await removeTokenSshKeyRecord(deps.db, entry.record.id);

      keysByFingerprint.delete(fingerprint);
      deps.onRemove(entry.record.id);
    },
    findSshKey: (blob) => {
      const entry = keysByFingerprint.get(formatKeyFingerprint(blob));
      const record = entry === undefined ? undefined : byId.get(entry.record.tokenId);

      if (entry === undefined || record === undefined) {
        return null;
      }

      return {
        key: entry.key,
        keyId: entry.record.id,
        caller: { ...toCaller(record), kind: 'ssh' },
      };
    },
    authenticate: (secret) => {
      const parsed = parseOpaqueToken(SECRET_PREFIX, secret);
      const record = parsed === null ? undefined : byId.get(parsed.id);

      if (parsed !== null && record !== undefined) {
        return isSameDigest(hashSecret(parsed.secret), Buffer.from(record.secretHash, 'hex'))
          ? toCaller(record)
          : null;
      }

      return isSameDigest(hashSecret(secret), rootHash) ? rootCaller : null;
    },
    findById: (id) => {
      if (id === ROOT_TOKEN_ID) {
        return rootCaller;
      }

      const record = byId.get(id);

      return record === undefined ? null : toCaller(record);
    },
    createRestored: async (tokens, keys) => {
      const restored: string[] = [];
      const skipped: { name: string; reason: string }[] = [];

      for (const record of tokens) {
        if (record.name === ROOT_NAME || findByName(record.name) !== null) {
          skipped.push({ name: record.name, reason: `a token named ${record.name} exists` });
          continue;
        }

        if (byId.has(record.id)) {
          skipped.push({ name: record.name, reason: `a token with id ${record.id} exists` });
          continue;
        }

        const entries: KeyEntry[] = [];

        for (const keyRecord of keys.filter((key) => key.tokenId === record.id)) {
          const key = parsePublicKey(keyRecord.publicKey);

          if (typeof key === 'string') {
            skipped.push({ name: record.name, reason: `key ${keyRecord.fingerprint}: ${key}` });
          } else if (
            keysByFingerprint.has(keyRecord.fingerprint) ||
            entries.some((entry) => entry.record.fingerprint === keyRecord.fingerprint) ||
            deps.isFileKey(key.blob)
          ) {
            skipped.push({
              name: record.name,
              reason: `key ${keyRecord.fingerprint} is bound here already or in authorized_keys`,
            });
          } else {
            entries.push({ record: keyRecord, key: { ...key, comment: keyRecord.comment } });
          }
        }

        await writeTokenRecord(
          deps.db,
          record,
          entries.map((entry) => entry.record),
        );

        byId.set(record.id, record);

        for (const entry of entries) {
          keysByFingerprint.set(entry.record.fingerprint, entry);
        }

        restored.push(record.name);
      }

      return { restored, skipped };
    },
  };
}

async function readGrantable(
  db: ImpQueries,
  names: readonly string[],
  token: Readonly<Pick<NewToken, 'scope' | 'imps'>>,
): Promise<GrantableSecret[]> {
  if (names.length === 0) {
    return [];
  }

  if (token.imps === null || token.scope !== 'manage') {
    throw new ImpdError('BAD_REQUEST', {
      message: 'a token that may grant secrets needs scope manage and imp patterns',
    });
  }

  const grantable: GrantableSecret[] = [];

  for (const name of names) {
    const secret = await readSecret(db, name);

    if (secret === undefined) {
      throw buildNotFoundError('secret', name);
    }

    grantable.push({ name, generation: secret.generation });
  }

  return grantable;
}

function requireImageScope(
  imageRefPrefix: string | null,
  token: Readonly<Pick<NewToken, 'scope' | 'imps'>>,
): void {
  if (imageRefPrefix !== null && (token.imps === null || token.scope !== 'manage')) {
    throw new ImpdError('BAD_REQUEST', {
      message: 'a token that may add images needs scope manage and imp patterns',
    });
  }
}

function buildKeyEntries(lines: readonly string[], build: (line: string) => KeyEntry): KeyEntry[] {
  const entries = lines.map((line) => build(line));

  const seen = new Set<string>();

  for (const entry of entries) {
    if (seen.has(entry.record.fingerprint)) {
      throw buildConflictError('ssh-key', entry.record.fingerprint, 'the same key is given twice');
    }

    seen.add(entry.record.fingerprint);
  }

  return entries;
}

export function findBearer(header: string | null): string | null {
  return header !== null && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
}

function toToken(record: Readonly<TokenRecord>): Omit<Token, 'sshKeys'> {
  return {
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    grantable: record.grantable.map((secret) => secret.name),
    imageRefPrefix: record.imageRefPrefix,
    createdAt: record.createdAt,
  };
}

function toSshKey(entry: Readonly<KeyEntry>): SshKey {
  return {
    fingerprint: entry.record.fingerprint,
    type: entry.key.type,
    comment: entry.record.comment,
  };
}

function toCaller(record: Readonly<TokenRecord>): Caller {
  return {
    kind: 'token',
    name: record.name,
    scope: record.scope,
    imps: record.imps,
    grantable: record.grantable,
    imageRefPrefix: record.imageRefPrefix,
    tokenId: record.id,
    grantId: null,
    expiresAt: null,

    principal: `token:${record.id}`,
    display: record.name,
  };
}
