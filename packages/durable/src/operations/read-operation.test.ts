import { expect, test } from 'bun:test';
import { buildRecordingOperation } from '../test-utils/build-recording-operation';
import { buildRecordingStep } from '../test-utils/build-recording-step';
import { createTestDurableDatabase } from '../test-utils/create-test-durable-database';
import { openTestDurableDatabase } from '../test-utils/open-test-durable-database';
import { queueOperation } from './queue-operation';
import { readOperation } from './read-operation';
import { writeCancelRequest } from './write-cancel-request';
import { writeStepUndo } from './write-step-undo';

async function setupTest() {
  const database = await createTestDurableDatabase();

  return { db: database.db, openWriter: () => openTestDurableDatabase(database.path) };
}

test('it returns null for an ID no operation has', async () => {
  const ctx = await setupTest();
  const operation = await readOperation(ctx.db, 'op-missing');

  expect(operation).toBeNull();
});

test('it reads the operation and its steps as one commit left them', async () => {
  const ctx = await setupTest();

  const writer = ctx.openWriter();
  const shelf = buildRecordingOperation('shelf.build', [buildRecordingStep({ name: 'cut' })], []);

  const queued = await queueOperation(ctx.db, shelf, {
    params: { label: 'oak' },
    principal: 'owner',
    targetId: null,
    parentId: null,
    retryKey: null,
    now: 1_800_000_000_000,
  });

  const reader = ctx.db.withPlugin({
    transformQuery: (args) => args.node,
    transformResult: async (args) => {
      await writer.transaction().execute(async (trx) => {
        await writeCancelRequest(trx, queued.operationId);
        await writeStepUndo(trx, { operationId: queued.operationId, position: 0, record: 'cut' });
      });

      return args.result;
    },
  });

  const operation = await readOperation(reader, queued.operationId);

  expect(operation).toStrictEqual(
    expect.objectContaining({
      cancelRequested: false,
      steps: [expect.objectContaining({ undoRecord: null })],
    }),
  );
});
