import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadOrCreateHostId(dataDir: string): string {
  // kept in the data dir: a re-registered ephemeral key replaces the tailnet
  // node, and the ID must outlive it
  const directory = join(dataDir, 'tailnet-names');
  const path = join(directory, 'host-id');

  if (existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }

  mkdirSync(directory, { recursive: true });

  const id = randomBytes(16).toString('hex');

  writeFileSync(path, `${id}\n`, { mode: 0o600, flag: 'wx' });

  return id;
}
