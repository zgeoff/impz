import { expect, test } from 'bun:test';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import type { Kysely, Transaction } from 'kysely';
import invariant from 'tiny-invariant';
import type { DurableTables } from '../durable-tables';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import type { RecordingParams } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { collectNetEffects } from '../test-utils/collect-net-effects';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { createChangeSignal } from './create-change-signal';
import { createOperationRunner } from './create-operation-runner';
import type { OperationDefinition } from './define-operation';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return {
    db: database.db,
    createRunner: (
      db: Kysely<DurableTables>,
      definitions: readonly OperationDefinition<RecordingParams>[],
    ) =>
      createOperationRunner({
        withTransaction: <T>(run: (trx: Transaction<DurableTables>) => Promise<T>) =>
          db.transaction().execute(run),
        definitions,
        changes: createChangeSignal(),
        now: () => 1_800_000_000_000,
        log: { warning: () => {} },
      }),
    reopen: () => openTestDurableDatabase(database.stack, database.path),
    readOperation: (db: Kysely<DurableTables>, id: string) => readOperation(db, id),
  };
}

test('it reruns a step that reruns when the process stopped before the step’s commit', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const hung = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure' }),
      buildRecordingStep({ name: 'cut', run: 'hang' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure' }),
      buildRecordingStep({ name: 'cut' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const started = await ctx.createRunner(ctx.db, [hung]).start(hung, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await waitFor(() => {
    expect(effects).toContain('cut');
  });

  const db = ctx.reopen();

  await ctx.createRunner(db, [shelf]).recover();

  const operation = await ctx.readOperation(db, started.operationId);

  expect(effects).toStrictEqual(['measure', 'cut', 'cut', 'assemble']);
  expect(operation?.state).toBe('succeeded');
});

test('it fails the operation and undoes the steps up to one that fails on a restart', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const hung = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({
        name: 'cut',
        run: 'hang',
        onRestart: 'fail',
        writesUndo: true,
        undo: 'succeed',
      }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', onRestart: 'fail', writesUndo: true, undo: 'succeed' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const started = await ctx.createRunner(ctx.db, [hung]).start(hung, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await waitFor(() => {
    expect(effects).toContain('cut');
  });

  const db = ctx.reopen();

  await ctx.createRunner(db, [shelf]).recover();

  const operation = await ctx.readOperation(db, started.operationId);

  expect(effects).toStrictEqual(['measure', 'cut', 'undo cut', 'undo measure']);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'failed',
      error: { code: 'interrupted', message: 'the process stopped during step cut' },
    }),
  );
});

test('it ends the operation unknown and reruns nothing when a step with an unknown effect was running', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const hung = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', run: 'hang', onRestart: 'unknown' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', onRestart: 'unknown' }),
      buildRecordingStep({ name: 'assemble' }),
    ],
    effects,
  );

  const started = await ctx.createRunner(ctx.db, [hung]).start(hung, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await waitFor(() => {
    expect(effects).toContain('cut');
  });

  const db = ctx.reopen();

  await ctx.createRunner(db, [shelf]).recover();

  const operation = await ctx.readOperation(db, started.operationId);

  expect(effects).toStrictEqual(['measure', 'cut']);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'unknown',
      currentStep: 'cut',
      error: { code: 'unknown', message: 'the effect of step cut is unknown' },
      steps: [
        expect.objectContaining({ name: 'measure', state: 'succeeded' }),
        expect.objectContaining({ name: 'cut', state: 'unknown' }),
        expect.objectContaining({ name: 'assemble', state: 'queued' }),
      ],
    }),
  );
});

test('it runs the undo again when the process stopped before the undo’s commit', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const hung = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'hang' }),
      buildRecordingStep({ name: 'cut', run: 'fail' }),
    ],
    effects,
  );

  const shelf = buildRecordingOperation(
    'shelf.build',
    [
      buildRecordingStep({ name: 'measure', undo: 'succeed' }),
      buildRecordingStep({ name: 'cut', run: 'fail' }),
    ],
    effects,
  );

  const started = await ctx.createRunner(ctx.db, [hung]).start(hung, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
  });

  await waitFor(() => {
    expect(effects).toContain('undo measure');
  });

  const db = ctx.reopen();

  await ctx.createRunner(db, [shelf]).recover();

  const operation = await ctx.readOperation(db, started.operationId);

  expect(effects).toStrictEqual(['measure', 'undo measure', 'undo measure']);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      state: 'failed',
      error: { code: 'step_failed', message: 'cut failed' },
    }),
  );
});

test('it runs a queued operation that never started', async () => {
  const ctx = await setupTest();

  const effects: string[] = [];

  const shelf = buildRecordingOperation(
    'shelf.build',
    [buildRecordingStep({ name: 'cut' })],
    effects,
  );

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

  await ctx.createRunner(ctx.db, [shelf]).recover();

  const operation = await ctx.readOperation(ctx.db, queued.operationId);

  expect(effects).toStrictEqual(['cut']);
  expect(operation?.state).toBe('succeeded');
});

test('it ends every operation succeeded or fully undone wherever the process stops', async () => {
  const ctx = await setupTest();

  const outcomes: { reached: string; state: string | undefined; kept: string[] }[] = [];

  const steps = [
    buildRecordingStep({ name: 'measure', undo: 'succeed' }),
    buildRecordingStep({ name: 'cut', onRestart: 'fail', writesUndo: true, undo: 'succeed' }),
    buildRecordingStep({ name: 'assemble' }),
  ];

  for (let stopAt = 1; outcomes.at(-1)?.reached !== 'finished'; stopAt += 1) {
    invariant(stopAt < 100, 'the operation never ran to its end');

    const database = await createTestDurableDatabase();

    const effects: string[] = [];
    const shelf = buildRecordingOperation('shelf.build', steps, effects);
    const stopped = Promise.withResolvers<'stopped'>();
    const calls = { count: 0 };

    const before = createOperationRunner({
      withTransaction: <T>(run: (trx: Transaction<DurableTables>) => Promise<T>): Promise<T> => {
        calls.count += 1;

        if (calls.count <= stopAt) {
          return database.db.transaction().execute(run);
        }

        stopped.resolve('stopped');

        return Promise.withResolvers<T>().promise;
      },
      definitions: [shelf],
      changes: createChangeSignal(),
      now: () => 1_800_000_000_000,
      log: { warning: () => {} },
    });

    const started = await before.start(shelf, {
      params: { label: 'oak' },
      principal: 'owner',
      targetId: null,
      parentId: null,
      retryKey: null,
    });

    const finished = (async () => {
      await before.run(started.operationId);

      return 'finished';
    })();

    const reached = await Promise.race([finished, stopped.promise]);

    const db = openTestDurableDatabase(database.stack, database.path);

    await ctx.createRunner(db, [shelf]).recover();

    const operation = await ctx.readOperation(db, started.operationId);

    outcomes.push({ reached, state: operation?.state, kept: collectNetEffects(effects) });
  }

  expect(outcomes).toSatisfyAll(
    (outcome: (typeof outcomes)[number]) =>
      (outcome.state === 'succeeded' &&
        outcome.kept.join(',') === ['measure', 'cut', 'assemble'].join(',')) ||
      (outcome.state === 'failed' && outcome.kept.length === 0),
  );

  expect(outcomes.map((outcome) => outcome.state)).toIncludeAllMembers(['succeeded', 'failed']);
});
