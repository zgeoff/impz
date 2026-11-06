import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readOperation } from './read-operation';

test('it returns null for an ID no operation has', async () => {
  const ctx = await createTestDurableDatabase();
  const operation = await readOperation(ctx.db, 'op-missing');

  expect(operation).toBeNull();
});
