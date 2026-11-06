import { expect, test } from 'bun:test';
import { appendEvent } from '../events/append-event';
import { readEventsAfter } from '../events/read-events-after';
import { createTestDurableDatabase } from './create-test-durable-database';
import { openTestDurableDatabase } from './open-test-durable-database';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { database };
}

test('it opens a second connection that sees the first connection’s commits', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.database.db, {
    at: 1,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const read = await readEventsAfter(
    openTestDurableDatabase(ctx.database.stack, ctx.database.path),
    { after: 0, limit: 10 },
  );

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ kind: 'note.added' })],
  });
});

test('it closes the second connection when the database’s stack is disposed', async () => {
  const ctx = await setupTest();

  const db = openTestDurableDatabase(ctx.database.stack, ctx.database.path);

  await ctx.database.stack.disposeAsync();

  const reading = db.selectFrom('event_log').select('log_id').execute();

  expect(reading).rejects.toThrow();
});
