import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { buildSQLiteDialect } from '@zgeoff/kysely-bun-sqlite';
import { Kysely } from 'kysely';
import type { DurableTables } from '../durable-tables';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { appendEvent } from './append-event';
import { pruneEvents } from './prune-events';
import { readEventsAfter } from './read-events-after';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db, path: database.path };
}

test('it returns the events after the cursor in sequence order', async () => {
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

  await appendEvent(ctx.db, {
    at: 1_800_000_002_000,
    kind: 'note.archived',
    targetId: 'note-1',
    operationId: 'op-1',
    payload: { reason: 'done' },
  });

  const read = await readEventsAfter(ctx.db, { after: 1, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [
      {
        seq: 2,
        at: 1_800_000_001_000,
        kind: 'note.added',
        targetId: 'note-2',
        operationId: null,
        payload: { title: 'Plants' },
      },
      {
        seq: 3,
        at: 1_800_000_002_000,
        kind: 'note.archived',
        targetId: 'note-1',
        operationId: 'op-1',
        payload: { reason: 'done' },
      },
    ],
  });
});

test('it returns no more events than the limit', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const read = await readEventsAfter(ctx.db, { after: 0, limit: 1 });

  expect(read).toStrictEqual({ kind: 'events', events: [expect.objectContaining({ seq: 1 })] });
});

test('it returns no events for a cursor at the head', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const read = await readEventsAfter(ctx.db, { after: 1, limit: 10 });

  expect(read).toStrictEqual({ kind: 'events', events: [] });
});

test('it returns a reset with the prune mark for a cursor before a pruned event', async () => {
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

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await pruneEvents(ctx.db, 1_800_000_000_000);

  const read = await readEventsAfter(ctx.db, { after: 1, limit: 10 });

  expect(read).toStrictEqual({ kind: 'reset', prunedThrough: 2 });
});

test('it returns the events for a cursor at the last pruned event', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.archived',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await pruneEvents(ctx.db, 1_800_000_000_000);

  const read = await readEventsAfter(ctx.db, { after: 1, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ seq: 2, kind: 'note.archived' })],
  });
});

test('it never skips an event that a prune on another connection removes during the read', async () => {
  const ctx = await setupTest();

  const sqlite = new Database(ctx.path);
  const pruner = new Kysely<DurableTables>({ dialect: buildSQLiteDialect(sqlite) });

  onTestFinished(() => {
    sqlite.close();
  });

  await appendEvent(ctx.db, {
    at: 1000,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'note.archived',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const reader = ctx.db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      await pruneEvents(pruner, 1_800_000_000_000);

      return args.result;
    },
  });

  const read = await readEventsAfter(reader, { after: 0, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ seq: 1 }), expect.objectContaining({ seq: 2 })],
  });
});
