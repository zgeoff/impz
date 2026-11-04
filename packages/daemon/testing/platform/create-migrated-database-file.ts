import { join } from 'node:path';
import { copyMigratedTemplate } from './copy-migrated-template';
import { readTemplateDependencies } from './read-template-dependencies';

// on disk, not in tmpdir(), which is a tmpfs that holds each file in RAM on
// some hosts
const CACHE_DIRECTORY = join(import.meta.dir, '../../node_modules/.cache/migrated-templates');

export async function createMigratedDatabaseFile(path: string, migration: string): Promise<void> {
  await copyMigratedTemplate(path, migration, readTemplateDependencies(CACHE_DIRECTORY));
}
