import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { Migrator } from 'kysely/migration';
import { durableMigrations } from '../migrations/durable-migrations';
import {
  createTestDurableDatabase,
  openTestConnection,
} from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { readLogID } from './read-log-id';

test('it returns the same log ID on every read of one database', async () => {
  const ctx = await createTestDurableDatabase();
  const first = await readLogID(ctx.db);
  const second = await readLogID(ctx.db);

  expect(second).toBe(first);
});

test('it returns the log ID a database was made with after a reopen', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogID(ctx.db);
  const after = await readLogID(openTestDurableDatabase(ctx.stack, ctx.path));

  expect(after).toBe(before);
});

test('it gives each migrated database a log ID of its own', async () => {
  const first = openTestConnection(new Database(':memory:'));
  const second = openTestConnection(new Database(':memory:'));

  onTestFinished(() => first.destroy());
  onTestFinished(() => second.destroy());

  await new Migrator({
    db: first,
    provider: { getMigrations: () => Promise.resolve({ ...durableMigrations }) },
  }).migrateToLatest();

  await new Migrator({
    db: second,
    provider: { getMigrations: () => Promise.resolve({ ...durableMigrations }) },
  }).migrateToLatest();

  const ids = [await readLogID(first), await readLogID(second)];

  expect(ids[1]).not.toBe(ids[0]);
});
