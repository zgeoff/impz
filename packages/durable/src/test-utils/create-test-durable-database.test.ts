import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from './create-test-durable-database';

test('it gives a test a migrated database with one event log row', async () => {
  const ctx = await createTestDurableDatabase();
  const rows = await ctx.db.selectFrom('event_log').select('pruned_through').execute();

  expect(rows).toStrictEqual([{ pruned_through: 0 }]);
});

test('it gives each call a database file of its own', async () => {
  const first = await createTestDurableDatabase();
  const second = await createTestDurableDatabase();

  await first.db
    .insertInto('events')
    .values({ at: 1, kind: 'note.added', target_id: null, operation_id: null, payload: '{}' })
    .execute();

  const rows = await second.db.selectFrom('events').selectAll().execute();

  expect(second.path).not.toBe(first.path);
  expect(rows).toStrictEqual([]);
});
