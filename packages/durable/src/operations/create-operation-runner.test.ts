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
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';
import { waitForChange } from './wait-for-change';

async function setupTest() {
  const database = await createTestDurableDatabase();

  const changes = createChangeSignal();
  const warnings: string[] = [];

  const withTransaction = <T>(run: (trx: Transaction<DurableTables>) => Promise<T>): Promise<T> =>
    database.db.transaction().execute(run);

  return {
    db: database.db,
    changes,
    warnings,
    createRunner: (definitions: readonly OperationDefinition<RecordingParams>[]) =>
      createOperationRunner({
        withTransaction,
        definitions,
        changes,
        now: () => 1_800_000_000_000,
        log: {
          warning: (message) => {
            warnings.push(message);
          },
        },
      }),
    readOperation: (id: string) => readOperation(database.db, id),
  };
}

test('it runs each step in order and ends the operation succeeded', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure' }),
      buildRecordingStep({ name: 'cut' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-1',
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  expect(effects).toStrictEqual(['measure', 'cut', 'assemble']);
});

test('it records the ended operation with each step and its times', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure' }), buildRecordingStep({ name: 'cut' })],
    [],
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-1',
    parentId: 'op-parent',
    retryKey: 'key-1',
  });

  await runner.run(started.operationId);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation).toStrictEqual({
    id: started.operationId,
    kind: 'shelf.build',
    targetId: 'shelf-1',
    parentId: 'op-parent',
    principal: 'owner',
    retryKey: 'key-1',
    params: { label: 'oak' },
    state: 'succeeded',
    currentStep: null,
    result: null,
    error: null,
    ending: null,
    cancelRequested: false,
    revision: expect.any(Number),
    createdAt: 1_800_000_000_000,
    startedAt: 1_800_000_000_000,
    endedAt: 1_800_000_000_000,
    steps: [
      {
        position: 0,
        name: 'measure',
        state: 'succeeded',
        startedAt: 1_800_000_000_000,
        endedAt: 1_800_000_000_000,
        error: null,
        undoRecord: null,
        undoneAt: null,
      },
      {
        position: 1,
        name: 'cut',
        state: 'succeeded',
        startedAt: 1_800_000_000_000,
        endedAt: 1_800_000_000_000,
        error: null,
        undoRecord: null,
        undoneAt: null,
      },
    ],
  });
});

test('it gives the operation a UUIDv7 ID', async () => {
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

  expect(started.operationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test('it writes an event for each change of the operation, in order', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: 'shelf-1',
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const events = await ctx.db
    .selectFrom('events')
    .select(['kind', 'target_id', 'operation_id', 'payload'])
    .orderBy('seq')
    .execute();

  expect(events).toStrictEqual([
    {
      kind: 'operation.queued',
      target_id: 'shelf-1',
      operation_id: started.operationId,
      payload: '{"kind":"shelf.build"}',
    },
    {
      kind: 'operation.started',
      target_id: 'shelf-1',
      operation_id: started.operationId,
      payload: '{"kind":"shelf.build","state":"running","step":null,"error":null}',
    },
    {
      kind: 'operation.step',
      target_id: 'shelf-1',
      operation_id: started.operationId,
      payload: '{"kind":"shelf.build","state":"running","step":"cut","error":null}',
    },
    {
      kind: 'operation.step',
      target_id: 'shelf-1',
      operation_id: started.operationId,
      payload: '{"kind":"shelf.build","state":"succeeded","step":"cut","error":null}',
    },
    {
      kind: 'operation.ended',
      target_id: 'shelf-1',
      operation_id: started.operationId,
      payload: '{"kind":"shelf.build","state":"succeeded","step":null,"error":null}',
    },
  ]);
});

test('it commits a step’s write with the step’s success', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', writesEvent: 'shelf.cut' })],
    [],
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const kinds = await ctx.db.selectFrom('events').select('kind').orderBy('seq').execute();

  expect(kinds.map((row) => row.kind)).toStrictEqual([
    'operation.queued',
    'operation.started',
    'operation.step',
    'shelf.cut',
    'operation.step',
    'operation.ended',
  ]);
});

test('it saves the result a step returns', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure', result: { widthCm: 80 } })],
    [],
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation?.result).toStrictEqual({ widthCm: 80 });
});

test('it undoes the steps that succeeded, last first, and ends failed when a step fails', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', undo: 'succeed' }),
      buildRecordingStep({ name: 'assemble', run: 'fail' }),
    ],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  expect(effects).toStrictEqual(['measure', 'cut', 'undo cut', 'undo measure']);
});

test('it ends the operation failed with the failed step’s error', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'measure' }), buildRecordingStep({ name: 'cut', run: 'fail' })],
    [],
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'failed',
      currentStep: 'cut',
      error: { code: 'step_failed', message: 'cut failed' },
    }),
  );
});

test('it undoes a failed step that wrote an undo record', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', run: 'fail', writesUndo: true, undo: 'succeed' })],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  expect(effects).toStrictEqual(['undo cut']);
});

test('it skips the undo of a failed step that wrote no undo record', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut', run: 'fail', undo: 'succeed' })],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  expect(effects).toStrictEqual([]);
});

test('it ends the operation failed and logs a warning when an undo fails', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'fail' }),
      buildRecordingStep({ name: 'cut', run: 'fail' }),
    ],
    [],
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await runner.run(started.operationId);

  const operation = await ctx.readOperation(started.operationId);

  expect(operation?.error).toStrictEqual({
    code: 'undo_failed',
    message: 'the undo of step measure failed: the undo of measure failed',
  });

  expect(ctx.warnings).toStrictEqual([
    'the undo of step {step} of operation {operationId} failed: {error}',
  ]);
});

test('it undoes the steps that ran and ends cancelled when cancelled during a step', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', run: 'wait-for-cancel' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const started = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await waitForChange(ctx.changes, {
    read: () => ctx.readOperation(started.operationId),
    isChanged: (operation) => operation?.currentStep === 'cut',
    signal: AbortSignal.timeout(4000),
  });

  await runner.cancel(started.operationId);
  await runner.run(started.operationId);

  const operation = await ctx.readOperation(started.operationId);

  expect(effects).toStrictEqual(['measure', 'undo measure']);
  expect(operation?.state).toBe('cancelled');
});

test('it ends a queued operation cancelled without running a step', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut' })],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const queued = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
    now: 1_800_000_000_000,
  });

  await runner.cancel(queued.operationId);
  await runner.run(queued.operationId);

  const operation = await ctx.readOperation(queued.operationId);

  expect(effects).toStrictEqual([]);
  expect(operation?.state).toBe('cancelled');
});

test('it returns the existing operation for a retry key with the same params', async () => {
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

  const second = await runner.start(shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
  });

  expect(second).toStrictEqual({ kind: 'existing', operationId: first.operationId });
});

test('it refuses a retry key with other params as a conflict', async () => {
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

  const second = await runner.start(shelf, {
    params: { label: 'pine' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: 'key-1',
  });

  expect(second).toStrictEqual({ kind: 'conflict', operationId: first.operationId });
});

test('it ends an operation of a kind the runner doesn’t define failed', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const paint = buildRecordingOperation('shelf.paint', [buildRecordingStep({ name: 'coat' })], []);
  const runner = ctx.createRunner([shelf]);

  const queued = await queueOperation(ctx.db, paint, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
    now: 1_800_000_000_000,
  });

  await runner.run(queued.operationId);

  const operation = await ctx.readOperation(queued.operationId);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'failed',
      error: { code: 'unknown_kind', message: 'no operation of kind shelf.paint is defined' },
    }),
  );
});

test('it runs an operation once when two callers run it at the same time', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut' })],
    effects,
  );

  const runner = ctx.createRunner([shelf]);

  const queued = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
    now: 1_800_000_000_000,
  });

  await Promise.all([runner.run(queued.operationId), runner.run(queued.operationId)]);

  expect(effects).toStrictEqual(['cut']);
});
