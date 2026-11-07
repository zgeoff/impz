import { expect, test } from 'bun:test';
import { createChangeSignal, createOperationRunner } from '@impz/durable';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { buildMockNewImp } from '../../test-utils/imps/build-mock-new-imp';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { createEventLogPruner } from './create-event-log-pruner';
import { createImage } from './images';
import { createImp } from './imps';
import type { ImpTransaction } from './with-imp-transaction';

async function setupTest() {
  const database = await createTestDatabase();

  const clock = { nowMs: Date.now() };
  const pruner = createEventLogPruner(database.db, () => clock.nowMs);

  const operations = createOperationRunner<ImpTransaction>({
    withTransaction: (run) => database.db.transaction().execute(run),
    definitions: [],
    changes: createChangeSignal(),
    now: () => clock.nowMs,
    log: { warning: () => {} },
  });

  return {
    db: database.db,
    clock,
    reconcile: () =>
      pruner.reconcile({
        signal: new AbortController().signal,
        log: { warning: () => {} },
        startOperation: operations.start,
      }),
  };
}

test('it removes the events older than 7 days', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  ctx.clock.nowMs += 8 * 86_400_000;

  const result = await ctx.reconcile();

  expect(result).toStrictEqual({ outcome: 'changed', summary: 'removed 1 event(s)' });

  const read = await ctx.db.log.readAfter(0, 10);

  expect(read).toStrictEqual({ kind: 'reset', prunedThrough: 1 });
});

test('it keeps the events of the last 7 days', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  ctx.clock.nowMs += 86_400_000;

  const result = await ctx.reconcile();

  expect(result).toStrictEqual({ outcome: 'unchanged', summary: 'removed 0 event(s)' });
});
