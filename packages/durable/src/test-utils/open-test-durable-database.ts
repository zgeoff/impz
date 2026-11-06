import { Database } from 'bun:sqlite';
import type { Kysely } from 'kysely';
import type { DurableTables } from '../durable-tables';
import { openTestConnection } from './create-test-durable-database';

export function openTestDurableDatabase(
  stack: AsyncDisposableStack,
  path: string,
): Kysely<DurableTables> {
  const db = openTestConnection(new Database(path));

  stack.defer(() => db.destroy());

  return db;
}
