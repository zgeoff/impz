import { expect, onTestFinished, test } from 'bun:test';
import { once } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { waitFor } from '@impz/shared/test-utils/wait-for';
import { sql } from 'kysely';
import type { Transaction } from 'kysely';
import type { DurableTables } from '../durable-tables';
import { createChangeSignal } from '../operations/create-change-signal';
import { createOperationRunner } from '../operations/create-operation-runner';
import type { OperationDefinition } from '../operations/define-operation';
import { readOperation } from '../operations/read-operation';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import type { RecordingParams } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { buildStubClock } from '../test-utils/build-stub-clock';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { createReconcilerRunner } from './create-reconciler-runner';
import { defineReconciler } from './define-reconciler';
import type { ReconcilerDefinition } from './define-reconciler';
import { readReconcilerResults } from './read-reconciler-results';

async function setupTest() {
  const database = await createTestDurableDatabase();

  const clock = buildStubClock(1_800_000_000_000);
  const warnings: string[] = [];

  const withTransaction = <T>(run: (trx: Transaction<DurableTables>) => Promise<T>): Promise<T> =>
    database.db.transaction().execute(run);

  const log = {
    warning: (message: string) => {
      warnings.push(message);
    },
  };

  return {
    db: database.db,
    clock,
    warnings,
    createRunner: (
      reconcilers: readonly ReconcilerDefinition<Transaction<DurableTables>>[],
      definitions: readonly OperationDefinition<RecordingParams>[],
      random: number,
    ) =>
      createReconcilerRunner({
        reconcilers,
        withTransaction,
        startOperation: createOperationRunner({
          withTransaction,
          definitions,
          changes: createChangeSignal(),
          now: clock.now,
          log,
        }).start,
        log,
        now: clock.now,
        random: () => random,
        startTimer: clock.startTimer,
      }),
    readResults: () => readReconcilerResults(database.db),
    readOperation: (id: string) => readOperation(database.db, id),
  };
}

test('it runs no pass before the interval passes', async () => {
  const ctx = await setupTest();

  const passes: number[] = [];

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'idle',
        intervalMs: 2000,
        reconcile: () => {
          passes.push(ctx.clock.now());

          return Promise.resolve({ outcome: 'unchanged', summary: 'no imp is idle' });
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  ctx.clock.runFor(1999);

  expect(passes).toStrictEqual([]);
});

test('it runs a pass once the interval passes', async () => {
  const ctx = await setupTest();

  const passes: number[] = [];

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'idle',
        intervalMs: 2000,
        reconcile: () => {
          passes.push(ctx.clock.now());

          return Promise.resolve({ outcome: 'unchanged', summary: 'nothing to sleep' });
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  ctx.clock.runFor(2000);

  await waitFor(() => {
    expect(passes).toStrictEqual([1_800_000_002_000]);
  });
});

test('it runs a pass at once on a trigger', async () => {
  const ctx = await setupTest();

  const passes: number[] = [];

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'disk-usage',
        intervalMs: 300_000,
        reconcile: () => {
          passes.push(ctx.clock.now());

          return Promise.resolve({ outcome: 'changed', summary: 'measured 3 disks' });
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('disk-usage');

  await waitFor(() => {
    expect(passes).toStrictEqual([1_800_000_000_000]);
  });
});

test('it runs one pass at a time, and one more after a trigger during a pass', async () => {
  const ctx = await setupTest();

  const gate = Promise.withResolvers<void>();
  const load = { now: 0, most: 0, passes: 0 };

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'gc',
        intervalMs: 3_600_000,
        reconcile: async () => {
          load.now += 1;
          load.most = Math.max(load.most, load.now);
          load.passes += 1;

          await gate.promise;

          load.now -= 1;

          return { outcome: 'unchanged', summary: 'nothing to collect' };
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('gc');
  runner.trigger('gc');
  runner.trigger('gc');
  gate.resolve();

  await waitFor(() => {
    expect(load).toStrictEqual({ now: 0, most: 1, passes: 2 });
  });
});

test('it backs off interval × 2ⁿ, capped at 10 × the interval, after errors in a row', async () => {
  const ctx = await setupTest();

  const delaysMs: number[][] = [];
  const passes = { count: 0 };

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'backup',
        intervalMs: 2000,
        reconcile: () => {
          passes.count += 1;

          return Promise.reject(new Error('the backup target is unreachable'));
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  for (const count of [1, 2, 3, 4, 5]) {
    ctx.clock.runFor(ctx.clock.readPendingMs()[0] ?? 0);

    await waitFor(() => {
      expect(runner.list()[0]?.last?.consecutiveErrors).toBe(count);
    });

    delaysMs.push(ctx.clock.readPendingMs());
  }

  expect(delaysMs).toStrictEqual([[4000], [8000], [16_000], [20_000], [20_000]]);
});

test.each([
  { random: 0.25, delayMs: 2500 },
  { random: 0.75, delayMs: 3500 },
])(
  'it waits $delayMs ms after an error for a random draw of $random, between half and all of the backoff',
  async (row) => {
    const ctx = await setupTest();

    const runner = ctx.createRunner(
      [
        defineReconciler({
          name: 'backup',
          intervalMs: 2000,
          reconcile: () => Promise.reject(new Error('the backup target is unreachable')),
        }),
      ],
      [],
      row.random,
    );

    await runner.start();

    onTestFinished(() => runner.stop());

    runner.trigger('backup');

    await waitFor(() => {
      expect(ctx.clock.readPendingMs()).toStrictEqual([row.delayMs]);
    });
  },
);

test('it waits one interval again after a pass that follows errors succeeds', async () => {
  const ctx = await setupTest();

  const results = [false, true];

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'broker',
        intervalMs: 60_000,
        reconcile: () =>
          results.shift() === true
            ? Promise.resolve({ outcome: 'unchanged', summary: 'grants match' })
            : Promise.reject(new Error('the broker is down')),
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('broker');

  await waitFor(() => {
    expect(ctx.clock.readPendingMs()).toStrictEqual([120_000]);
  });

  runner.trigger('broker');

  await waitFor(() => {
    expect(ctx.clock.readPendingMs()).toStrictEqual([60_000]);
  });
});

test('it saves the first result of a reconciler', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'memory',
        intervalMs: 500,
        reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'within budget' }),
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('memory');

  await waitFor(async () => {
    const results = await ctx.readResults();

    expect(results).toStrictEqual([
      {
        name: 'memory',
        outcome: 'unchanged',
        summary: 'within budget',
        consecutiveErrors: 0,
        at: 1_800_000_000_000,
      },
    ]);
  });
});

test('it skips the save when a pass repeats the saved outcome', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'memory',
        intervalMs: 500,
        reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'within budget' }),
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  ctx.clock.runFor(500);

  await waitFor(() => {
    expect(runner.list()[0]?.nextRunAt).toBe(1_800_000_001_000);
  });

  ctx.clock.runFor(500);

  await waitFor(() => {
    expect(runner.list()[0]?.last?.at).toBe(1_800_000_001_000);
  });

  const results = await ctx.readResults();

  expect(results).toStrictEqual([expect.objectContaining({ at: 1_800_000_000_500 })]);
});

test('it saves the result when the outcome changes', async () => {
  const ctx = await setupTest();

  const outcomes = ['unchanged', 'changed'] as const;
  const passes = { count: 0 };

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'governor',
        intervalMs: 1000,
        reconcile: () => {
          const outcome = outcomes[passes.count] ?? 'changed';

          passes.count += 1;

          return Promise.resolve({ outcome, summary: `pass ${String(passes.count)}` });
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  ctx.clock.runFor(1000);

  await waitFor(() => {
    expect(runner.list()[0]?.nextRunAt).toBe(1_800_000_002_000);
  });

  ctx.clock.runFor(1000);

  await waitFor(async () => {
    const results = await ctx.readResults();

    expect(results).toStrictEqual([
      expect.objectContaining({ outcome: 'changed', summary: 'pass 2', at: 1_800_000_002_000 }),
    ]);
  });
});

test('it skips the save on its first pass when the outcome matches the one saved before a restart', async () => {
  const ctx = await setupTest();

  const memory = defineReconciler({
    name: 'memory',
    intervalMs: 500,
    reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'within budget' }),
  });

  const before = ctx.createRunner([memory], [], 1);

  await before.start();

  before.trigger('memory');

  await waitFor(async () => {
    const results = await ctx.readResults();

    expect(results).toHaveLength(1);
  });

  await before.stop();

  const after = ctx.createRunner([memory], [], 1);

  await after.start();

  onTestFinished(() => after.stop());

  ctx.clock.runFor(500);

  await waitFor(() => {
    expect(after.list()[0]?.last?.at).toBe(1_800_000_000_500);
  });

  const results = await ctx.readResults();

  expect(results).toStrictEqual([expect.objectContaining({ at: 1_800_000_000_000 })]);
});

test('it lists each reconciler’s last result, errors in a row and next run', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'backup',
        intervalMs: 2000,
        reconcile: () => Promise.reject(new Error('the backup target is unreachable')),
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('backup');

  await waitFor(() => {
    expect(runner.list()).toStrictEqual([
      {
        name: 'backup',
        intervalMs: 2000,
        last: {
          name: 'backup',
          outcome: 'error',
          summary: 'the backup target is unreachable',
          consecutiveErrors: 1,
          at: 1_800_000_000_000,
        },
        running: false,
        nextRunAt: 1_800_000_004_000,
      },
    ]);
  });
});

test('it logs a warning when a pass throws', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'backup',
        intervalMs: 2000,
        reconcile: () => Promise.reject(new Error('the backup target is unreachable')),
      }),
    ],
    [],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('backup');

  await waitFor(() => {
    expect(ctx.warnings).toStrictEqual(['reconciler {name} failed: {error}']);
  });
});

test('it lets a pass start an operation', async () => {
  const ctx = await setupTest();

  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);
  const started: string[] = [];

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'idle',
        intervalMs: 2000,
        reconcile: async (reconcile) => {
          const outcome = await reconcile.startOperation(shelf, {
            params: { label: 'oak' },
            principal: 'reconciler idle',
            targetId: 'shelf-1',
            parentId: null,
            retryKey: null,
          });

          started.push(outcome.operationId);

          return { outcome: 'changed', summary: '1 shelf built' };
        },
      }),
    ],
    [shelf],
    1,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('idle');

  await waitFor(async () => {
    const operation = await ctx.readOperation(started[0] ?? '');

    expect(operation).toStrictEqual(
      expect.objectContaining({ principal: 'reconciler idle', state: 'succeeded' }),
    );
  });
});

test('it aborts a running pass’s signal on stop and waits for the pass to end', async () => {
  const ctx = await setupTest();

  const ended: string[] = [];
  const release = Promise.withResolvers<void>();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'proxy',
        intervalMs: 30_000,
        reconcile: async (reconcile) => {
          await once(reconcile.signal, 'abort');

          ended.push('aborted');

          await release.promise;

          ended.push('released');

          return { outcome: 'unchanged', summary: 'stopped' };
        },
      }),
    ],
    [],
    1,
  );

  await runner.start();

  runner.trigger('proxy');

  await waitFor(() => {
    expect(runner.list()[0]?.running).toBe(true);
  });

  const stopping = (async () => {
    await runner.stop();

    ended.push('stopped');
  })();

  await waitFor(() => {
    expect(ended).toStrictEqual(['aborted']);
  });

  await setImmediate();

  release.resolve();

  await stopping;

  expect(ended).toStrictEqual(['aborted', 'released', 'stopped']);
});

test('it starts no reconciler when a stop arrives while it starts', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'idle',
        intervalMs: 2000,
        reconcile: () => Promise.resolve({ outcome: 'unchanged', summary: 'no imp is idle' }),
      }),
    ],
    [],
    1,
  );

  const starting = runner.start();

  await runner.stop();

  await starting;

  expect(ctx.clock.readPendingMs()).toStrictEqual([]);
});

test('it saves a result on the next pass after a save fails', async () => {
  const ctx = await setupTest();

  const runner = ctx.createRunner(
    [
      defineReconciler({
        name: 'backup',
        intervalMs: 2000,
        reconcile: () => Promise.resolve({ outcome: 'changed', summary: 'pruned 3 backups' }),
      }),
    ],
    [],
    1,
  );

  await sql`create trigger refuse_results before insert on reconcilers begin select raise(abort, 'the disk is full'); end`.execute(
    ctx.db,
  );

  await runner.start();

  onTestFinished(() => runner.stop());

  runner.trigger('backup');

  await waitFor(() => {
    expect(ctx.warnings).toStrictEqual(['the result of reconciler {name} was not saved: {error}']);
  });

  await sql`drop trigger refuse_results`.execute(ctx.db);

  runner.trigger('backup');

  await waitFor(async () => {
    const results = await ctx.readResults();

    expect(results).toStrictEqual([
      {
        name: 'backup',
        outcome: 'changed',
        summary: 'pruned 3 backups',
        consecutiveErrors: 0,
        at: 1_800_000_000_000,
      },
    ]);
  });
});
