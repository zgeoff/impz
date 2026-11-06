import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { appendEvent } from '../events/append-event';
import { readEventsAfter } from '../events/read-events-after';
import { createTestDurableDatabase } from './create-test-durable-database';

test('it closes the database and removes its folder when the test ends', async () => {
  const ctx = await createTestDurableDatabase();

  onTestFinished(() => {
    const reading = ctx.db.selectFrom('event_log').select('log_id').execute();

    expect(reading).rejects.toThrow();
    expect(existsSync(dirname(ctx.path))).toBe(false);
  });
});

test('it gives a test a migrated database with one event log row', async () => {
  const ctx = await createTestDurableDatabase();
  const rows = await ctx.db.selectFrom('event_log').select('pruned_through').execute();

  expect(rows).toStrictEqual([{ pruned_through: 0 }]);
});

test('it gives each call a database file of its own', async () => {
  const first = await createTestDurableDatabase();
  const second = await createTestDurableDatabase();

  await appendEvent(first.db, {
    at: 1,
    kind: 'note.added',
    targetId: null,
    operationId: null,
    payload: {},
  });

  const read = await readEventsAfter(second.db, { after: 0, limit: 10 });

  expect(second.path).not.toBe(first.path);
  expect(read).toStrictEqual({ kind: 'events', events: [] });
});
