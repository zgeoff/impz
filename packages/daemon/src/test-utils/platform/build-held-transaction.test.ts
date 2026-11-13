import { expect, test } from 'bun:test';
import { sql } from 'kysely';
import { buildHeldTransaction } from './build-held-transaction';
import { createTestDatabase } from './create-test-database';

test('it rolls back a write that reaches sqlite while the transaction is open', async () => {
  const testDatabase = await createTestDatabase();

  const held = buildHeldTransaction(testDatabase.db);

  testDatabase.db.sqlite.run('CREATE TABLE held_probe (id INTEGER)');

  await held.open();

  held.db.sqlite.query('INSERT INTO held_probe (id) VALUES (1)').run();

  await held.rollBack();

  const rows = await sql`SELECT id FROM held_probe`.execute(testDatabase.db);

  expect(rows.rows).toStrictEqual([]);
});

test('it runs a query made through its database once the transaction has rolled back', async () => {
  const testDatabase = await createTestDatabase();

  const held = buildHeldTransaction(testDatabase.db);

  await held.open();

  const query = sql<{ one: number }>`SELECT 1 AS one`.execute(held.db);

  await held.rollBack();

  const result = await query;

  expect(result.rows).toStrictEqual([{ one: 1 }]);
});
