import { expect, onTestFinished, test } from 'bun:test';
import { createTestDurableDatabase } from './create-test-durable-database';
import { openTestDurableDatabase } from './open-test-durable-database';

async function setupTest() {
  const database = await createTestDurableDatabase();

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return { database, stack };
}

test('it opens a second connection that sees the first connection’s commits', async () => {
  const ctx = await setupTest();

  await ctx.database.db
    .insertInto('events')
    .values({ at: 1, kind: 'note.added', target_id: null, operation_id: null, payload: '{}' })
    .execute();

  const rows = await openTestDurableDatabase(ctx.stack, ctx.database.path)
    .selectFrom('events')
    .select('kind')
    .execute();

  expect(rows).toStrictEqual([{ kind: 'note.added' }]);
});

test('it closes the second connection when its stack is disposed', async () => {
  const ctx = await setupTest();

  const db = openTestDurableDatabase(ctx.stack, ctx.database.path);

  await ctx.stack.disposeAsync();

  const reading = db.selectFrom('event_log').select('log_id').execute();

  expect(reading).rejects.toThrow();
});
