import { expect, test } from 'bun:test';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db, readOperation: (id: string) => readOperation(database.db, id) };
}

test('it stores a queued operation with a queued row for each step', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure' }), buildRecordingStep({ name: 'cut' })],
    [],
  );

  const queued = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-1',
    parentId: null,
    retryKey: null,
    now: 1_800_000_000_000,
  });

  const operation = await ctx.readOperation(queued.operationId);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'queued',
      createdAt: 1_800_000_000_000,
      startedAt: null,
      steps: [
        expect.objectContaining({ position: 0, name: 'measure', state: 'queued' }),
        expect.objectContaining({ position: 1, name: 'cut', state: 'queued' }),
      ],
    }),
  );
});

test('it writes nothing when the caller’s transaction rolls back', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const write = ctx.db.transaction().execute(async (trx) => {
    await queueOperation(trx, shelf, {
      params: { label: 'oak' },
      principal: 'owner',
      targetId: null,
      parentId: null,
      retryKey: null,
      now: 1_800_000_000_000,
    });

    throw new Error('the domain write failed');
  });

  await write.catch(() => {});

  const rows = [
    await ctx.db.selectFrom('operations').select('id').execute(),
    await ctx.db.selectFrom('operation_steps').select('name').execute(),
    await ctx.db.selectFrom('events').select('kind').execute(),
  ];

  expect(write).rejects.toThrowWithMessage(Error, /the domain write failed/u);
  expect(rows).toStrictEqual([[], [], []]);
});

test('it matches a retry key whatever the order of the params’ keys', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const first = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak', widthCm: 80 },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  const second = await queueOperation(ctx.db, shelf, {
    params: { widthCm: 80, label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  expect(second).toStrictEqual({ kind: 'existing', operationId: first.operationId });
});

test('it refuses the key of an operation of another kind as a conflict', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const paint = buildRecordingOperation('shelf.paint', [buildRecordingStep({ name: 'coat' })], []);

  const first = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  const second = await queueOperation(ctx.db, paint, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  expect(second).toStrictEqual({ kind: 'conflict', operationId: first.operationId });
});

test('it refuses the key of an operation on another target as a conflict', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const first = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-1',
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  const second = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-2',
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_000_000_000,
  });

  expect(second).toStrictEqual({ kind: 'conflict', operationId: first.operationId });
});
