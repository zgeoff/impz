import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintSecret } from '../platform/secrets/mint-secret';

export function token(dataDir: string): string {
  const path = join(dataDir, 'token');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  const secret = mintSecret();

  writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: 'wx' });

  return secret;
}
