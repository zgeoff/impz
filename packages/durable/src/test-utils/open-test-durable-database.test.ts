import { expect, onTestFinished, test } from 'bun:test';
import { appendEvent } from '../events/append-event';
import { readEventsAfter } from '../events/read-events-after';
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

  await appendEvent(ctx.database.db, {
    at: 1,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const read = await readEventsAfter(openTestDurableDatabase(ctx.stack, ctx.database.path), {
    after: 0,
    limit: 10,
  });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ kind: 'note.added' })],
  });
});

test('it closes the second connection when its stack is disposed', async () => {
  const ctx = await setupTest();

  const db = openTestDurableDatabase(ctx.stack, ctx.database.path);

  await ctx.stack.disposeAsync();

  const reading = db.selectFrom('event_log').select('log_id').execute();

  expect(reading).rejects.toThrow();
});
