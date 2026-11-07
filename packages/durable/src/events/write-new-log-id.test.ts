import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogId } from './read-log-id';
import { writeNewLogId } from './write-new-log-id';

test('it gives the log a log ID other than the one it had', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogId(ctx.db);

  await writeNewLogId(ctx.db);

  const logId = await readLogId(ctx.db);

  expect(logId).not.toBe(before);
});

test('it returns the log ID it wrote', async () => {
  const ctx = await createTestDurableDatabase();
  const written = await writeNewLogId(ctx.db);
  const logId = await readLogId(ctx.db);

  expect(logId).toBe(written);
});
