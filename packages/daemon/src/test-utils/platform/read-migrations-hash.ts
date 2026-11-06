import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function readMigrationsHash(dbDirectory: string): string {
  const hasher = new Bun.CryptoHasher('sha256');

  const migrations = readdirSync(join(dbDirectory, 'migrations'))
    .toSorted()
    .map((name) => join('migrations', name));

  for (const file of ['run-migrations.ts', ...migrations]) {
    hasher.update(file);
    hasher.update(readFileSync(join(dbDirectory, file)));
  }

  return hasher.digest('hex').slice(0, 16);
}
