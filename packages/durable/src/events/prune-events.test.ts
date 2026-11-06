import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { appendEvent } from './append-event';
import { pruneEvents } from './prune-events';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db };
}

test('it removes the events older than 7 days', async () => {
  const ctx = await setupTest();

  const now = 1_800_000_000_000;

  await appendEvent(ctx.db, {
    at: now - 604_800_001,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await appendEvent(ctx.db, {
    at: now - 604_800_000,
    kind: 'note.archived',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await pruneEvents(ctx.db, now);

  const rows = await ctx.db.selectFrom('events').select('kind').execute();

  expect(rows).toStrictEqual([{ kind: 'note.archived' }]);
});

test('it returns the number of events it removed', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await appendEvent(ctx.db, {
    at: 2000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const removed = await pruneEvents(ctx.db, 1_800_000_000_000);

  expect(removed).toBe(2);
});

test('it keeps the newest 100,000 events when more are younger than 7 days', async () => {
  const ctx = await setupTest();

  const now = 1_800_000_000_000;

  await ctx.db.transaction().execute(async (trx) => {
    for (let count = 0; count < 100_002; count += 1) {
      await appendEvent(trx, {
        at: now,
        kind: 'note.added',
        targetId: null,
        operationId: null,
        payload: {},
      });
    }
  });

  await pruneEvents(ctx.db, now);

  const kept = await ctx.db
    .selectFrom('events')
    .select((eb) => [eb.fn.countAll<number>().as('count'), eb.fn.min('seq').as('oldest')])
    .executeTakeFirstOrThrow();

  expect(kept).toStrictEqual({ count: 100_000, oldest: 3 });
});

test('it removes nothing and returns 0 when every event is young', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const removed = await pruneEvents(ctx.db, 1_800_000_000_000);

  expect(removed).toBe(0);
});
