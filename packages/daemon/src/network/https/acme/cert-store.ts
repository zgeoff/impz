import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { getImpdLogger } from '../../../platform/process/get-impd-logger';
import { writeFileDurably } from '../../../platform/process/write-file-durably';

export interface Certificate {
  readonly keyPem: string;
  readonly chainPem: string;
}

// kept so a restart does not retry at once and run into the CA's limit on
// failed validations
export interface AttemptState {
  readonly failures: number;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
}

const AttemptStateSchema = z.object({
  failures: z.int().nonnegative(),
  lastAttemptAt: z.number().nullable(),
  lastError: z.string().nullable(),
});

interface AcmeAccount {
  readonly directoryUrl: string;
  readonly url: string;
  readonly keyPem: string;
}

const AccountSchema = z.object({ directoryUrl: z.string(), url: z.string(), keyPem: z.string() });

// the layout an impd up to v0.1.1 wrote: the key in account.key, the URL
// alone in account.json
const LegacyAccountSchema = z.object({ directoryUrl: z.string(), url: z.string() });
const NO_ATTEMPTS: AttemptState = { failures: 0, lastAttemptAt: null, lastError: null };

export interface CertStore {
  readonly readCertificate: () => Certificate | null;
  readonly writeCertificate: (certificate: Certificate) => void;

  readonly readAccount: (directoryUrl: string) => AcmeAccount | null;
  readonly writeAccount: (account: AcmeAccount) => void;
  readonly readAttempts: () => AttemptState;
  readonly writeAttempts: (state: AttemptState) => void;
}

export function createCertStore(dataDir: string): CertStore {
  const directory = join(dataDir, 'tls');
  const certificatePath = join(directory, 'certificate.pem');
  const attemptsPath = join(directory, 'attempts.json');
  const accountPath = join(directory, 'account.json');
  const legacyKeyPath = join(directory, 'account.key');
  const warned = { account: false };

  const write = (path: string, content: string): void => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileDurably(path, content, { mode: 0o600 });
  };

  const readStoredAccount = (directoryUrl: string): AcmeAccount | null => {
    const text = readIfExists(accountPath);

    if (text === null) {
      return null;
    }

    const json = parseJson(text);
    const account = AccountSchema.safeParse(json);

    if (account.success) {
      return account.data;
    }

    const legacy = LegacyAccountSchema.safeParse(json);
    const legacyKey = readIfExists(legacyKeyPath);

    if (legacy.success && legacyKey !== null && legacy.data.directoryUrl === directoryUrl) {
      const migrated = { ...legacy.data, keyPem: legacyKey };

      write(accountPath, `${JSON.stringify(migrated)}\n`);

      return migrated;
    }

    if (!legacy.success && !warned.account) {
      warned.account = true;

      getImpdLogger('https').info('{accountPath} does not parse; making a new ACME account', {
        accountPath,
      });
    }

    return null;
  };

  return {
    readCertificate: () => {
      const pem = readIfExists(certificatePath);

      return pem === null ? null : splitCertificate(pem);
    },
    writeCertificate: (certificate) => {
      // one file for both, so a crash never pairs a key with the wrong certificate
      write(
        certificatePath,
        `${certificate.keyPem.trimEnd()}\n${certificate.chainPem.trimEnd()}\n`,
      );
    },
    readAccount: (directoryUrl) => {
      const account = readStoredAccount(directoryUrl);

      rmSync(legacyKeyPath, { force: true });

      return account?.directoryUrl === directoryUrl ? account : null;
    },
    writeAccount: (account) => {
      write(accountPath, `${JSON.stringify(account)}\n`);
    },
    readAttempts: () => {
      const text = readIfExists(attemptsPath);

      try {
        return text === null ? NO_ATTEMPTS : AttemptStateSchema.parse(JSON.parse(text));
      } catch {
        return NO_ATTEMPTS;
      }
    },
    writeAttempts: (state) => {
      write(attemptsPath, `${JSON.stringify(state)}\n`);
    },
  };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

const PEM_BLOCK = /-----BEGIN (?<label>[A-Z ]+)-----[\s\S]+?-----END \k<label>-----\n?/gu;

function splitCertificate(pem: string): Certificate | null {
  const blocks = [...pem.matchAll(PEM_BLOCK)];
  const key = blocks.find((block) => block.groups?.['label']?.endsWith('PRIVATE KEY') === true);
  const chain = blocks.filter((block) => block.groups?.['label'] === 'CERTIFICATE');

  if (key === undefined || chain.length === 0) {
    return null;
  }

  return {
    keyPem: key[0].trimEnd(),
    chainPem: chain.map((block) => block[0].trimEnd()).join('\n'),
  };
}
