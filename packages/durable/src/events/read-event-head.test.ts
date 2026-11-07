import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { appendEvent } from './append-event';
import { pruneEvents } from './prune-events';
import { readEventHead } from './read-event-head';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return {
    db: database.db,
    prune: (now: number) => database.db.transaction().execute((trx) => pruneEvents(trx, now)),
  };
}

test('it returns 0 for a log with no events', async () => {
  const ctx = await setupTest();
  const head = await readEventHead(ctx.db);

  expect(head).toBe(0);
});

test('it returns the seq of the last event appended', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: 'note-1',
    operationId: null,
    payload: { title: 'Groceries' },
  });

  await appendEvent(ctx.db, {
    at: 1_800_000_001_000,
    kind: 'note.added',
    targetId: 'note-2',
    operationId: null,
    payload: { title: 'Plants' },
  });

  const head = await readEventHead(ctx.db);

  expect(head).toBe(2);
});

test('it returns the last pruned seq once a prune removes every event', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: 'note-1',
    operationId: null,
    payload: { title: 'Groceries' },
  });

  await ctx.prune(1_800_000_000_000 + 8 * 24 * 60 * 60 * 1000);

  const head = await readEventHead(ctx.db);

  expect(head).toBe(1);
});
