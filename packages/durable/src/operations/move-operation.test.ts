import { expect, test } from 'bun:test';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { canMoveOperation, moveOperation } from './move-operation';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db, readOperation: (id: string) => readOperation(database.db, id) };
}

test.each([
  { from: 'queued', to: 'running', allowed: true },
  { from: 'queued', to: 'failed', allowed: true },
  { from: 'queued', to: 'cancelled', allowed: true },
  { from: 'queued', to: 'succeeded', allowed: false },
  { from: 'running', to: 'running', allowed: true },
  { from: 'running', to: 'succeeded', allowed: true },
  { from: 'running', to: 'unknown', allowed: true },
  { from: 'running', to: 'queued', allowed: false },
  { from: 'succeeded', to: 'running', allowed: false },
  { from: 'failed', to: 'running', allowed: false },
  { from: 'cancelled', to: 'running', allowed: false },
  { from: 'unknown', to: 'running', allowed: false },
] as const)('#canMoveOperation answers $allowed for $from → $to', (row) => {
  expect(canMoveOperation(row.from, row.to)).toBe(row.allowed);
});

test('#moveOperation moves the state and counts a revision', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const queued = await ctx.db.transaction().execute((trx) =>
    queueOperation(trx, shelf, {
      params: { label: 'oak' },
      principal: 'owner',
      targetId: null,
      parentId: null,
      retryKey: null,
      now: 1_800_000_000_000,
    }),
  );

  await moveOperation(ctx.db, { id: queued.operationId, from: 'queued', to: 'running' });

  const operation = await ctx.readOperation(queued.operationId);

  expect(operation).toStrictEqual(expect.objectContaining({ state: 'running', revision: 1 }));
});

test('#moveOperation refuses a move from a state the operation has left', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const queued = await ctx.db.transaction().execute((trx) =>
    queueOperation(trx, shelf, {
      params: { label: 'oak' },
      principal: 'owner',
      targetId: null,
      parentId: null,
      retryKey: null,
      now: 1_800_000_000_000,
    }),
  );

  const move = moveOperation(ctx.db, { id: queued.operationId, from: 'running', to: 'succeeded' });

  expect(move).rejects.toThrowWithMessage(Error, /is no longer running/u);
});
