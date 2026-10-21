import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { formatKeyFingerprint } from '../../imps/ssh/authorized-keys';

export function setupSshDir(dataDir: string): string {
  const directory = join(dataDir, 'ssh');

  mkdirSync(directory, { recursive: true, mode: 0o700 });

  return directory;
}

export function loadOrCreateHostKey(sshDir: string): string {
  const path = join(sshDir, 'host_key');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8');
  }

  const pair = generateEd25519Key();

  writeFileSync(path, pair.private, { mode: 0o600, flag: 'wx' });

  return pair.private;
}

// ssh2's generator drops a leading zero byte of the public key (1 key in
// 256), and that key does not parse, so such a key is made again.
const MAX_KEY_ATTEMPTS = 16;

interface KeyPair {
  readonly private: string;
  readonly public: string;
}

export function generateEd25519Key(
  generate: () => KeyPair = () => utils.generateKeyPairSync('ed25519'),
): KeyPair {
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
    const pair = generate();

    if (!(utils.parseKey(pair.private) instanceof Error)) {
      return pair;
    }
  }

  throw new Error(`no readable ed25519 key in ${String(MAX_KEY_ATTEMPTS)} attempts`);
}

export function readFingerprint(privateKey: string): string {
  const parsed = utils.parseKey(privateKey);

  if (parsed instanceof Error) {
    throw parsed;
  }

  return formatKeyFingerprint(parsed.getPublicSSH());
}
