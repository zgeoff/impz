import { SecretNameSchema } from '@impz/api';
import type { BackupRestore } from '@impz/api';
import type { TokenStore } from '../../identity/auth/token-store';
import { createRestoredSecrets } from '../../platform/db/create-restored-secrets';
import { openDatabase } from '../../platform/db/open-database';
import type { ImpDatabase } from '../../platform/db/open-database';
import { listSecretRows } from '../../platform/db/secrets';
import type { SecretRow } from '../../platform/db/secrets';
import { listTokenRecords, listTokenSshKeyRecords } from '../../platform/db/tokens';

type RestoredAccess = NonNullable<BackupRestore['database']>;

export async function createRestoredAccess(
  db: ImpDatabase,
  tokens: Pick<TokenStore, 'createRestored'>,
  copyPath: string,
): Promise<RestoredAccess> {
  const copied = await readCopiedAccess(copyPath);

  const kept = copied.secrets.filter((row) => isOwnValueFile(row));

  const refused = copied.secrets
    .filter((row) => !isOwnValueFile(row))
    .map((row) => ({
      name: row.name,
      reason: `secret ${row.name}: its value file is not a name impd gives`,
    }));

  const secrets = await createRestoredSecrets(db, kept);
  const made = await tokens.createRestored(copied.tokens, copied.keys);

  return { tokens: made.restored, secrets, skipped: [...refused, ...made.skipped] };
}

async function readCopiedAccess(copyPath: string) {
  const copy = await openDatabase(copyPath);

  try {
    return {
      secrets: await listSecretRows(copy),
      tokens: await listTokenRecords(copy),
      keys: await listTokenSshKeyRecords(copy),
    };
  } finally {
    await copy.destroy();
  }
}

// The broker reads and removes a value file by its name in the secrets
// directory, so a row from an altered copy may name only `<name>` or
// `<name>.<16 hex>`, never a file outside it.
function isOwnValueFile(row: Readonly<SecretRow>): boolean {
  if (!SecretNameSchema.safeParse(row.name).success) {
    return false;
  }

  const suffix = row.value_file.slice(row.name.length);

  return row.value_file.startsWith(row.name) && (suffix === '' || /^\.[0-9a-f]{16}$/v.test(suffix));
}
