import { expect, test } from 'bun:test';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { canMoveStep, moveStep } from './move-step';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db, readOperation: (id: string) => readOperation(database.db, id) };
}

test.each([
  { from: 'queued', to: 'running', allowed: true },
  { from: 'queued', to: 'succeeded', allowed: false },
  { from: 'running', to: 'succeeded', allowed: true },
  { from: 'running', to: 'failed', allowed: true },
  { from: 'running', to: 'unknown', allowed: true },
  { from: 'running', to: 'queued', allowed: false },
  { from: 'succeeded', to: 'running', allowed: false },
  { from: 'failed', to: 'running', allowed: false },
  { from: 'unknown', to: 'running', allowed: false },
] as const)('#canMoveStep answers $allowed for $from → $to', (row) => {
  expect(canMoveStep(row.from, row.to)).toBe(row.allowed);
});

test('#moveStep moves the step’s state', async () => {
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

  await moveStep(ctx.db, {
    operationId: queued.operationId,
    position: 0,
    from: 'queued',
    to: 'running',
    set: { started_at: 1_800_000_000_000 },
  });

  const operation = await ctx.readOperation(queued.operationId);

  expect(operation?.steps).toStrictEqual([
    expect.objectContaining({ state: 'running', startedAt: 1_800_000_000_000 }),
  ]);
});

test('#moveStep refuses a move from a state the step has left', async () => {
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

  const move = moveStep(ctx.db, {
    operationId: queued.operationId,
    position: 0,
    from: 'running',
    to: 'succeeded',
  });

  expect(move).rejects.toThrowWithMessage(Error, /is no longer running/u);
});
