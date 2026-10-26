import type { Secret, SecretAdd, SecretAdded } from '@impz/api';
import type { ImpDatabase } from '../../../platform/db/open-database';
import {
  createSecret,
  listSecrets,
  readSecret,
  removeFileRemoval,
  removeSecret,
  upsertSecret,
} from '../../../platform/db/secrets';
import type { NewSecret, SecretRecord } from '../../../platform/db/secrets';
import { ImpdError } from '../../../platform/errors/impd-error';
import { buildConflictError, buildNotFoundError } from '../../../platform/errors/impd-errors';
import { getErrorMessage } from '../../../platform/process/get-error-message';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { buildStoredBinding } from './build-stored-binding';
import type { OAuthRefresher } from './oauth-refresher';
import { findIdClaims, parseOAuthState } from './oauth-state';
import { buildValueFile } from './secret-files';
import type { SecretFiles } from './secret-files';
import { SECRET_KINDS } from './secret-kinds';

interface SecretStore {
  readonly addSecret: (input: Readonly<SecretAdd>) => Promise<SecretAdded>;
  readonly listSecrets: () => Promise<Secret[]>;

  readonly refreshSecret: (name: string) => Promise<Secret>;
  readonly removeSecret: (name: string) => Promise<void>;
}

interface SecretStoreDeps {
  readonly db: ImpDatabase;
  readonly files: SecretFiles;
  readonly refresher: OAuthRefresher;

  readonly applyGrants: () => Promise<void>;
}

export function createSecretStore(deps: SecretStoreDeps): SecretStore {
  const db = deps.db;
  const files = deps.files;
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
      env: secret.env,
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
    input: Readonly<SecretAdd>,
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
      getImpdLogger('broker').warning('could not remove an old secret value file: {error}', {
        error: getErrorMessage(error),
      });
    }
  };

  return {
    addSecret: async (input) => {
      const binding = buildStoredBinding(input);
      const kind = SECRET_KINDS[binding.kind];

      const saved = await refresher.withLock(input.name, async () => {
        const valueFile = buildValueFile(input.name);

        files.write(valueFile, kind.formatValueFile(input.value));

        const written = await writeSecretRow({ name: input.name, ...binding, valueFile }, input);

        if (written.oldValueFile !== null) {
          await removeDisplacedFile(written.oldValueFile);

          await deps.applyGrants();
        }

        return written;
      });

      if (kind.isRefreshed) {
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

      if (!SECRET_KINDS[secret.kind].isRefreshed) {
        throw new ImpdError('BAD_REQUEST', { message: `secret ${name} is not an oauth secret` });
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
  return new ImpdError('CONFLICT', {
    message: `secret ${name} would get other hosts or headers; a rebind (--rebind) drops its grants`,
    data: { kind: 'secret', name, reason: 'binding_changed' },
  });
}
