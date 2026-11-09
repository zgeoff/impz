import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { createOutsideWriteTriggers } from './create-outside-write-triggers';
import { readLogId } from './read-log-id';

async function setupTest() {
  const ctx = await createTestDurableDatabase();

  await sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`.execute(ctx.db);

  return {
    ...ctx,
    openOtherWriter: () => openTestDurableDatabase(ctx.stack, ctx.path),
  };
}

test.each([
  ['an insert', `INSERT INTO notes (id, body) VALUES (2, 'buy figs')`],
  ['an update', `UPDATE notes SET body = 'buy plums' WHERE id = 1`],
  ['a delete', `DELETE FROM notes WHERE id = 1`],
])(
  'it empties the log ID on %s by a connection that made no triggers',
  async (_write, statement) => {
    const ctx = await setupTest();

    await createOutsideWriteTriggers(ctx.db, ['notes']);

    await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(ctx.db);

    const other = ctx.openOtherWriter();

    await sql.raw(statement).execute(other);

    const logId = await readLogId(ctx.db);

    expect(logId).toBe('');
  },
);

test.each([
  ['an insert', `INSERT INTO notes (id, body) VALUES (2, 'buy figs')`],
  ['an update', `UPDATE notes SET body = 'buy plums' WHERE id = 1`],
  ['a delete', `DELETE FROM notes WHERE id = 1`],
])(
  'it keeps the log ID on %s by the connection that made the triggers',
  async (_write, statement) => {
    const ctx = await setupTest();
    const before = await readLogId(ctx.db);

    await createOutsideWriteTriggers(ctx.db, ['notes']);

    await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(ctx.db);
    await sql.raw(statement).execute(ctx.db);

    const logId = await readLogId(ctx.db);

    expect(logId).toBe(before);
  },
);

test('it keeps the triggers working when a later connection makes them again', async () => {
  const ctx = await setupTest();

  await createOutsideWriteTriggers(ctx.db, ['notes']);

  const later = ctx.openOtherWriter();

  await createOutsideWriteTriggers(later, ['notes']);

  const other = ctx.openOtherWriter();

  await sql`INSERT INTO notes (id, body) VALUES (1, 'buy pears')`.execute(other);

  const logId = await readLogId(ctx.db);

  expect(logId).toBe('');
});
