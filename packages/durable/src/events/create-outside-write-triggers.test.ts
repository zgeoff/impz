import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { createOutsideWriteTriggers } from './create-outside-write-triggers';
import { readLogId } from './read-log-id';
import { removeLogId } from './remove-log-id';
import { removeLogIdAfterOutsideWrites } from './remove-log-id-after-outside-writes';
import { writeNewLogId } from './write-new-log-id';

async function setupTest() {
  const ctx = await createTestDurableDatabase();

  await sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.execute(ctx.db);

  return {
    ...ctx,
    reopen: async () => {
      await removeLogIdAfterOutsideWrites(ctx.db);
      await writeNewLogId(ctx.db);
    },
  };
}

test.each([
  ['an insert', `INSERT INTO notes (id, body) VALUES (2, 'buy figs')`],
  ['an update', `UPDATE notes SET body = 'buy plums' WHERE id = 1`],
  ['a delete', `DELETE FROM notes WHERE id = 1`],
])(
  'it gives the log a new ID at the next open after %s by a connection without the triggers',
  async (_write, statement) => {
    const ctx = await setupTest();
    const before = await readLogId(ctx.db);

    await createOutsideWriteTriggers(ctx.db, ['notes']);

    await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(ctx.db);

    const other = openTestDurableDatabase(ctx.stack, ctx.path);

    await sql.raw(statement).execute(other);
    await ctx.reopen();

    const logId = await readLogId(ctx.db);

    expect(logId).not.toBeOneOf(['', before]);
  },
);

test.each([
  ['an insert', `INSERT INTO notes (id, body) VALUES (2, 'buy figs')`],
  ['an update', `UPDATE notes SET body = 'buy plums' WHERE id = 1`],
  ['a delete', `DELETE FROM notes WHERE id = 1`],
])(
  'it keeps the log ID at the next open after %s by the connection that made the triggers',
  async (_write, statement) => {
    const ctx = await setupTest();
    const before = await readLogId(ctx.db);

    await createOutsideWriteTriggers(ctx.db, ['notes']);

    await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(ctx.db);
    await sql.raw(statement).execute(ctx.db);
    await ctx.reopen();

    const logId = await readLogId(ctx.db);

    expect(logId).toBe(before);
  },
);

test('it keeps the log ID that a connection without the triggers reads after its own write', async () => {
  const ctx = await setupTest();
  const before = await readLogId(ctx.db);

  await createOutsideWriteTriggers(ctx.db, ['notes']);

  const other = openTestDurableDatabase(ctx.stack, ctx.path);

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);

  const logId = await readLogId(other);

  expect(logId).toBe(before);
});

test('it gives the log one new ID for the writes before an open, and none at the open after', async () => {
  const ctx = await setupTest();

  await createOutsideWriteTriggers(ctx.db, ['notes']);

  const other = openTestDurableDatabase(ctx.stack, ctx.path);

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);
  await ctx.reopen();

  const rotated = await readLogId(ctx.db);

  await ctx.reopen();

  const logId = await readLogId(ctx.db);

  expect(logId).toBe(rotated);
});

test('it lets the connection that made the triggers remove the log ID', async () => {
  const ctx = await setupTest();

  await createOutsideWriteTriggers(ctx.db, ['notes']);
  await removeLogId(ctx.db);

  const logId = await readLogId(ctx.db);

  expect(logId).toBe('');
});

test('it keeps the triggers working when a later connection makes them again', async () => {
  const ctx = await setupTest();
  const before = await readLogId(ctx.db);

  await createOutsideWriteTriggers(ctx.db, ['notes']);

  const later = openTestDurableDatabase(ctx.stack, ctx.path);

  await createOutsideWriteTriggers(later, ['notes']);

  const other = openTestDurableDatabase(ctx.stack, ctx.path);

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);
  await ctx.reopen();

  const logId = await readLogId(ctx.db);

  expect(logId).not.toBeOneOf(['', before]);
});
