import { expect, test } from 'bun:test';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { readLogID } from './read-log-id';
import { removeLogID } from './remove-log-id';
import { writeNewLogID } from './write-new-log-id';

test('it gives a log with no log ID a new one', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogID(ctx.db);

  await removeLogID(ctx.db);
  await writeNewLogID(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).not.toBeOneOf(['', before]);
});

test('it keeps the log ID a log already has', async () => {
  const ctx = await createTestDurableDatabase();
  const before = await readLogID(ctx.db);

  await writeNewLogID(ctx.db);

  const logID = await readLogID(ctx.db);

  expect(logID).toBe(before);
});
