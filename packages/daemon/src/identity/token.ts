import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintSecret } from '../platform/secrets/mint-secret';

export function loadOrCreateToken(dataDir: string): string {
  const path = join(dataDir, 'token');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  const token = mintSecret();

  writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });

  return token;
}
