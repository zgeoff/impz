import { expect, test } from 'bun:test';
import type { Transaction } from 'kysely';
import type { DurableTables } from '../durable-tables';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import type { RecordingParams } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { createChangeSignal } from './create-change-signal';
import { createOperationRunner } from './create-operation-runner';
import type { OperationDefinition } from './define-operation';
import { pruneOperations } from './prune-operations';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return {
    db: database.db,
    createRunner: (definitions: readonly OperationDefinition<RecordingParams>[]) =>
      createOperationRunner({
        withTransaction: <T>(run: (trx: Transaction<DurableTables>) => Promise<T>) =>
          database.db.transaction().execute(run),
        definitions,
        changes: createChangeSignal(),
        now: () => 1_800_000_000_000,
        log: { warning: () => {} },
      }),
    readOperation: (id: string) => readOperation(database.db, id),
  };
}

test('it clears the retry key of an operation that ended 24 hours ago', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
  });

  await runner.run(started.operationId);

  await pruneOperations(ctx.db, 1_800_086_400_000);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation?.retryKey).toBeNull();
});

test('it keeps the retry key of an operation that ended less than 24 hours ago', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
  });

  await runner.run(started.operationId);

  await pruneOperations(ctx.db, 1_800_086_399_999);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation?.retryKey).toBe('key-1');
});

test('it removes an operation that ended 30 days ago, with its steps', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const removed = await pruneOperations(ctx.db, 1_802_592_000_000);
  const steps = await ctx.db.selectFrom('operation_steps').select('name').execute();

  expect(removed).toBe(1);
  expect(steps).toStrictEqual([]);
});

test('it keeps an operation that ended less than 30 days ago', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const removed = await pruneOperations(ctx.db, 1_802_591_999_999);

  expect(removed).toBe(0);
});

test('it keeps an open operation however old it is', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const queued = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_000_000_000_000,
  });

  await pruneOperations(ctx.db, 1_900_000_000_000);

  const operation = await ctx.readOperation(queued.operationId);

  expect(operation?.retryKey).toBe('key-1');
});

test('it lets a retry key whose operation ended 24 hours ago start a new operation', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const first = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
  });

  await runner.run(first.operationId);

  const second = await queueOperation(ctx.db, shelf, {
    params: { label: 'pine' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
    now: 1_800_086_400_000,
  });

  expect(second).toStrictEqual({
    kind: 'queued',
    operationId: expect.not.stringMatching(first.operationId),
  });
});
