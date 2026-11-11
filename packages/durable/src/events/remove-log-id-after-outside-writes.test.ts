import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { createOutsideWriteTriggers } from './create-outside-write-triggers';
import { readLogID } from './read-log-id';
import { removeLogIDAfterOutsideWrites } from './remove-log-id-after-outside-writes';
import { writeNewLogID } from './write-new-log-id';

async function setupTest() {
  const ctx = await createTestDurableDatabase();

  await sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.execute(ctx.db);

  await createOutsideWriteTriggers(ctx.db, ['notes']);

  return ctx;
}

test('it keeps the log ID when no outside write left a mark', async () => {
  const ctx = await setupTest();
  const before = await readLogID(ctx.db);

  await removeLogIDAfterOutsideWrites(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).toBe(before);
});

test('it removes the log ID when an outside write left a mark', async () => {
  const ctx = await setupTest();

  const other = openTestDurableDatabase(ctx.stack, ctx.path);

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);

  await removeLogIDAfterOutsideWrites(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).toBe('');
});

test('it keeps the log ID a later open gave the log once it removed the mark', async () => {
  const ctx = await setupTest();

  const other = openTestDurableDatabase(ctx.stack, ctx.path);

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);

  await removeLogIDAfterOutsideWrites(ctx.db);
  await writeNewLogID(ctx.db);

  const before = await readLogID(ctx.db);

  await removeLogIDAfterOutsideWrites(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).toBe(before);
});
