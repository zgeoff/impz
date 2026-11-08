import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogId } from './read-log-id';
import { removeLogId } from './remove-log-id';

test('it leaves the log with an empty log ID', async () => {
  const ctx = await createTestDurableDatabase();

  await removeLogId(ctx.db);

  const logId = await readLogId(ctx.db);

  expect(logId).toBe('');
});
