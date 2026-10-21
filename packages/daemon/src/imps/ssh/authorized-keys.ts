import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { utils } from 'ssh2';

export interface AuthorizedKey {
  readonly type: string;
  readonly blob: Buffer;
  readonly comment: string;
  readonly verify: (data: Buffer, signature: Buffer, hashAlgo: string | undefined) => boolean;
}

export interface ParsedAuthorizedKeys {
  readonly keys: readonly AuthorizedKey[];
  readonly problems: readonly string[];
}

// The gateway does not enforce authorized_keys options such as `from=` or `command=`, so a line
// that starts with them is refused rather than granting more than it says.
const KEY_TYPE = /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/u;

export function parseAuthorizedKeys(text: string): ParsedAuthorizedKeys {
  const keys: AuthorizedKey[] = [];
  const problems: string[] = [];

  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();

    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const parsed = parsePublicKey(line);

    if (typeof parsed === 'string') {
      problems.push(`line ${String(index + 1)}: ${parsed}`);
      continue;
    }

    keys.push(parsed);
  }

  return { keys, problems };
}

export function parsePublicKey(line: string): AuthorizedKey | string {
  const [type = '', data = '', ...rest] = line.trim().split(/\s+/u);

  if (!KEY_TYPE.test(type)) {
    return /^(?:sk-|ssh-dss)/u.test(type)
      ? `${type} keys are not supported`
      : 'options are not supported; put the key type first';
  }

  const parsed = utils.parseKey(`${type} ${data}`);

  if (parsed instanceof Error) {
    return parsed.message;
  }

  return {
    type: parsed.type,
    blob: parsed.getPublicSSH(),
    comment: rest.join(' '),
    verify: (signed, signature, hashAlgo) => parsed.verify(signed, signature, hashAlgo),
  };
}

export function formatKeyFingerprint(blob: Buffer): string {
  const digest = createHash('sha256').update(blob).digest('base64');

  return `SHA256:${digest.replace(/=+$/u, '')}`;
}

export interface AuthorizedKeys {
  readonly readKey: (blob: Buffer) => AuthorizedKey | null;

  // Ignores the file's mode, because fixing the mode would grant a listed key again.
  readonly probeListed: (blob: Buffer) => boolean;
}

interface FileState {
  readonly stamp: string;
  readonly keys: readonly AuthorizedKey[];
  readonly isSafe: boolean;
}

export function createAuthorizedKeys(path: string, log: (message: string) => void): AuthorizedKeys {
  const state: { current: FileState | null } = { current: null };

  const load = (): FileState => {
    const stamp = readStamp(path);

    if (state.current?.stamp === stamp) {
      return state.current;
    }

    state.current = readFileState(path, stamp, log);

    return state.current;
  };

  const readListed = (blob: Buffer): AuthorizedKey | null =>
    load().keys.find((key) => key.blob.equals(blob)) ?? null;

  return {
    readKey: (blob) => (load().isSafe ? readListed(blob) : null),
    probeListed: (blob) => readListed(blob) !== null,
  };
}

function readStamp(path: string): string {
  try {
    const file = statSync(path);
    const directory = statSync(dirname(path));

    return [file.mtimeMs, file.size, file.mode, file.ino, directory.mode].join(':');
  } catch {
    return 'missing';
  }
}

function readFileState(path: string, stamp: string, log: (message: string) => void): FileState {
  if (stamp === 'missing') {
    log(`impd: ssh: no ${path}; no key can log in`);

    return { stamp, keys: [], isSafe: true };
  }

  const unsafe = [path, dirname(path)].find((each) => (statSync(each).mode & 0o022) !== 0);

  if (unsafe !== undefined) {
    log(`impd: ssh: ${unsafe} is writable by group or others; no key can log in until it is not`);
  }

  const parsed = parseAuthorizedKeys(readFileSync(path, 'utf8'));

  for (const problem of parsed.problems) {
    log(`impd: ssh: ${path} ${problem}; skipped`);
  }

  return { stamp, keys: parsed.keys, isSafe: unsafe === undefined };
}
