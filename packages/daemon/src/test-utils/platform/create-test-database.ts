import { onTestFinished } from 'bun:test';
import { openMigratedCopy } from '@impz/testing/stand-in/platform/open-migrated-copy';
import type { ImpDatabase } from '../../platform/db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openMigratedCopy();

  onTestFinished(() => db.destroy());

  return { db };
}
