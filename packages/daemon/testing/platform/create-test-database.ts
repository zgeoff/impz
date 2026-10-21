import { onTestFinished } from 'bun:test';
import { openDatabase } from '../../src/platform/db/open-database';
import type { ImpDatabase } from '../../src/platform/db/open-database';

interface TestDatabase {
  readonly db: ImpDatabase;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = await openDatabase(':memory:');

  onTestFinished(() => db.destroy());

  return { db };
}
