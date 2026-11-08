import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogId } from './read-log-id';
import { removeLogId } from './remove-log-id';
import { writeNewLogId } from './write-new-log-id';

test('it gives a log with no log ID a new one', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogId(ctx.db);

  await removeLogId(ctx.db);
  await writeNewLogId(ctx.db);

  const logId = await readLogId(ctx.db);

  expect(logId).not.toBeOneOf(['', before]);
});

test('it keeps the log ID a log already has', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogId(ctx.db);

  await writeNewLogId(ctx.db);

  const logId = await readLogId(ctx.db);

  expect(logId).toBe(before);
});
