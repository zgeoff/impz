import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, 'token');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  const token = randomBytes(32).toString('base64url');

  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });

  return token;
}
