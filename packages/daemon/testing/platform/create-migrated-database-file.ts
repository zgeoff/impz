import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMigratedTemplate } from './create-migrated-template';

// on disk, not in tmpdir(), which is a tmpfs that holds each file in RAM on
// some hosts
const CACHE_DIRECTORY = join(import.meta.dir, '../../node_modules/.cache/migrated-templates');

export async function createMigratedDatabaseFile(path: string, migration: string): Promise<void> {
  const template = await createMigratedTemplate(CACHE_DIRECTORY, migration);

  copyFileSync(template, path);
}
