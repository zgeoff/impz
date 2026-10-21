import type { BrokerRule, OAuthConfig, Secret, SecretAdded, SecretKind } from '@impz/api';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { ORPCError } from '@orpc/server';
import type { ImpDatabase } from '../../platform/db/open-database';
import {
  createSecret,
  listSecrets,
  readSecret,
  removeFileRemoval,
  removeSecret,
  upsertSecret,
} from '../../platform/db/secrets';
import type { NewSecret, SecretRecord } from '../../platform/db/secrets';
import { getErrorMessage } from '../../platform/process/get-error-message';
// oxlint-disable-next-line zgeoff/import-zones -- GEO-364 gives this layer its own errors
import { buildConflictError, buildNotFoundError } from '../../surface/api-errors';
import { SecretRulesError, resolveRules } from './connector-kinds';
import type { OAuthRefresher } from './oauth-refresher';
import { buildPendingState, findIdClaims, formatOAuthState, parseOAuthState } from './oauth-state';
import { buildValueFile } from './secret-files';
import type { SecretFiles } from './secret-files';

export interface AddSecretInput {
  readonly name: string;
  readonly kind: SecretKind;
  readonly value: string;
  readonly rules?: readonly BrokerRule[] | undefined;

  readonly oauth?: OAuthConfig | undefined;
  readonly replace?: boolean | undefined;
  readonly rebind?: boolean | undefined;
}

interface SecretStore {
  readonly addSecret: (input: AddSecretInput) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;

  readonly refreshSecret: (name: string) => Promise<Secret>;
  readonly removeSecret: (name: string) => Promise<void>;
}

interface SecretStoreDeps {
  readonly db: ImpDatabase;
  readonly files: SecretFiles;
  readonly log: (message: string) => void;
  readonly refresher: OAuthRefresher;

  readonly applyGrants: () => Promise<void>;
}

export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const db = deps.db;
  const files = deps.files;
  const log = deps.log;
  const refresher = deps.refresher;

  const readApiSecret = async (secret: SecretRecord): Promise<Secret> => {
    const listed = await listSecrets(db);

    const imps = listed.find((entry) => entry.secret.name === secret.name)?.imps ?? [];

    return buildSecretView(secret, imps);
  };

  const buildSecretView = (secret: SecretRecord, imps: readonly string[]): Secret => {
    const shown: Secret = {
      name: secret.name,
      kind: secret.kind,
      rules: secret.rules,
      imps,
      createdAt: secret.createdAt,
    };

    if (secret.kind !== 'oauth' || secret.oauth === null) {
      return shown;
    }

    const text = files.read(secret.valueFile);
    const stored = text === null ? null : parseOAuthState(text);

    return {
      ...shown,
      oauth: {
        ...secret.oauth,
        status: stored?.status ?? 'needs_login',
        expiresAt: toDate(stored?.expiresAt),
        refreshedAt: toDate(stored?.refreshedAt),
        error: stored === null ? 'value file missing or unreadable' : stored.error,
        idClaims: findIdClaims(stored?.idToken ?? null),
      },
    };
  };

  const writeSecretRow = async (
    secret: Readonly<NewSecret>,
    input: Readonly<AddSecretInput>,
  ): Promise<{
    readonly secret: SecretRecord;
    readonly oldValueFile: string | null;
    readonly droppedGrants: number;
  }> => {
    try {
      if (input.replace !== true) {
        const made = await createSecret(db, secret);

        if (made === null) {
          throw buildConflictError('secret', secret.name);
        }

        return { secret: made, oldValueFile: null, droppedGrants: 0 };
      }

      const outcome = await upsertSecret(db, secret, input.rebind === true);

      if (outcome.kind === 'binding-changed') {
        throw buildBindingChangedError(secret.name);
      }

      return outcome;
    } catch (error) {
      files.remove(secret.valueFile);
      throw error;
    }
  };

  const removeDisplacedFile = async (file: string): Promise<void> => {
    try {
      files.remove(file);

      await removeFileRemoval(db, file);
    } catch (error) {
      log(`impd: broker: could not remove an old secret value file: ${getErrorMessage(error)}`);
    }
  };

  return {
    addSecret: async (input) => {
      let rules: readonly BrokerRule[];

      try {
        rules = resolveRules(input.kind, input.rules);
      } catch (error) {
        if (error instanceof SecretRulesError) {
          throw new ORPCError('BAD_REQUEST', { message: error.message });
        }

        throw error;
      }

      if (input.kind === 'oauth' && input.oauth === undefined) {
        throw new ORPCError('BAD_REQUEST', {
          message: 'kind oauth needs a token URL and a client id',
        });
      }

      if (input.kind !== 'oauth' && input.oauth !== undefined) {
        throw new ORPCError('BAD_REQUEST', {
          message: `kind ${input.kind} has no token URL or client id; they are for kind oauth`,
        });
      }

      const oauth = input.kind === 'oauth' ? (input.oauth ?? null) : null;

      const saved = await refresher.withLock(input.name, async () => {
        const valueFile = buildValueFile(input.name);

        const content =
          input.kind === 'oauth' ? formatOAuthState(buildPendingState(input.value)) : input.value;

        files.write(valueFile, content);

        const written = await writeSecretRow(
          { name: input.name, kind: input.kind, rules, oauth, valueFile },
          input,
        );

        if (written.oldValueFile !== null) {
          await removeDisplacedFile(written.oldValueFile);

          await deps.applyGrants();
        }

        return written;
      });

      if (input.kind === 'oauth') {
        await refresher.refresh(input.name, true);
      }

      const latest = await readSecret(db, input.name);
      const shown = await readApiSecret(latest ?? saved.secret);

      return { ...shown, droppedGrants: saved.droppedGrants };
    },

    listSecrets: async () => {
      const listed = await listSecrets(db);

      return listed.map((entry) => buildSecretView(entry.secret, entry.imps));
    },

    refreshSecret: async (name) => {
      const secret = await readSecret(db, name);

      if (secret === undefined) {
        throw buildNotFoundError('secret', name);
      }

      if (secret.kind !== 'oauth') {
        throw new ORPCError('BAD_REQUEST', { message: `secret ${name} is not an oauth secret` });
      }

      await refresher.refresh(name, true);

      const current = await readSecret(db, name);

      if (current === undefined) {
        throw buildNotFoundError('secret', name);
      }

      return readApiSecret(current);
    },

    removeSecret: async (name) => {
      await refresher.withLock(name, async () => {
        const valueFile = await removeSecret(db, name);

        if (valueFile === null) {
          throw buildNotFoundError('secret', name);
        }

        await removeDisplacedFile(valueFile);

        await deps.applyGrants();
      });
    },
  };
}

function toDate(durationMs: number | null | undefined): Date | null {
  return durationMs === null || durationMs === undefined ? null : new Date(durationMs);
}

function buildBindingChangedError(name: string) {
  return new ORPCError('CONFLICT', {
    message: `secret ${name} would get other hosts or headers; a rebind (--rebind) drops its grants`,
    data: { kind: 'secret', name, reason: 'binding_changed' },
  });
}
