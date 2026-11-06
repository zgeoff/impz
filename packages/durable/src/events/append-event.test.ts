import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { appendEvent } from './append-event';
import { pruneEvents } from './prune-events';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db };
}

test('it gives each event the next sequence number', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: 'note-1',
    operationId: null,
    payload: { title: 'Groceries' },
  });

  const seq = await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.archived',
    targetId: 'note-1',
    operationId: 'op-1',
    payload: { reason: 'done' },
  });

  expect(seq).toBe(2);
});

test('it stores the event as the caller gave it', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: 'note-1',
    operationId: 'op-1',
    payload: { title: 'Groceries', tags: ['home'] },
  });

  const row = await ctx.db.selectFrom('events').selectAll().executeTakeFirstOrThrow();

  expect(row).toStrictEqual({
    seq: 1,
    at: 1_800_000_000_000,
    kind: 'note.added',
    target_id: 'note-1',
    operation_id: 'op-1',
    payload: '{"title":"Groceries","tags":["home"]}',
  });
});

test('it leaves no event row when the caller’s transaction rolls back', async () => {
  const ctx = await setupTest();

  const write = ctx.db.transaction().execute(async (trx) => {
    await appendEvent(trx, {
      at: 1_800_000_000_000,
      kind: 'note.added',
      targetId: 'note-1',
      operationId: null,
      payload: {},
    });

    throw new Error('the domain write failed');
  });

  await write.catch(() => {});

  const rows = await ctx.db.selectFrom('events').selectAll().execute();

  expect(write).rejects.toThrowWithMessage(Error, /the domain write failed/u);
  expect(rows).toStrictEqual([]);
});

test('it commits the event row with the caller’s transaction', async () => {
  const ctx = await setupTest();

  await ctx.db.transaction().execute((trx) =>
    appendEvent(trx, {
      at: 1_800_000_000_000,
      kind: 'note.added',
      targetId: 'note-1',
      operationId: null,
      payload: {},
    }),
  );

  const rows = await ctx.db.selectFrom('events').select('kind').execute();

  expect(rows).toStrictEqual([{ kind: 'note.added' }]);
});

test('it never reuses the sequence number of a pruned event', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await pruneEvents(ctx.db, 1_800_000_000_000);

  const seq = await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  expect(seq).toBe(2);
});
