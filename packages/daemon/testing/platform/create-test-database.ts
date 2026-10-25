import { onTestFinished } from 'bun:test';
import type { ImpDatabase } from '../../src/platform/db/open-database';
import { openMigratedCopy } from './open-migrated-copy';

interface TestDatabase {
  readonly db: ImpDatabase;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openMigratedCopy();

  onTestFinished(() => db.destroy());

  return { db };
}
