import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { DurableTables } from '../durable-tables';
import { durableMigrations } from '../migrations/durable-migrations';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogId } from './read-log-id';

test('it returns the same log ID on every read of one database', async () => {
  const ctx = await createTestDurableDatabase();
  const first = await readLogId(ctx.db);
  const second = await readLogId(ctx.db);

  expect(second).toBe(first);
});

test('it returns the log ID a database was made with after a reopen', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogId(ctx.db);

  const sqlite = new Database(ctx.path);

  onTestFinished(() => sqlite.close());

  const after = await readLogId(new Kysely<DurableTables>({ dialect: buildSQLiteDialect(sqlite) }));

  expect(after).toBe(before);
});

test('it gives each migrated database a log ID of its own', async () => {
  const first = new Kysely<DurableTables>({
    dialect: buildSQLiteDialect(new Database(':memory:')),
  });

  const second = new Kysely<DurableTables>({
    dialect: buildSQLiteDialect(new Database(':memory:')),
  });

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

  const ids = [await readLogId(first), await readLogId(second)];

  expect(ids[1]).not.toBe(ids[0]);
});
