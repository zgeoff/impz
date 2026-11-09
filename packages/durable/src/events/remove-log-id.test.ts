import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogID } from './read-log-id';
import { removeLogID } from './remove-log-id';

test('it leaves the log with an empty log ID', async () => {
  const ctx = await createTestDurableDatabase();

  await removeLogID(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).toBe('');
});
