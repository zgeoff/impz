import { expect, test } from 'bun:test';
import { buildMockMoveSendRow } from '../../../testing/imp-ops/build-mock-move-send-row';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import {
  readMoveSend,
  removeMoveSend,
  updateMoveSend,
  updateMoveSendStep,
  writeMoveSend,
} from './move-sends';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('#findMoveSend reads the row it wrote for the imp', async () => {
  const ctx = await setupTest();

  const row = buildMockMoveSendRow({ imp_id: 'imp-1' });

  await writeMoveSend(ctx.db, row);

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(found).toStrictEqual(row);
});

test('#findMoveSend finds nothing for an imp with no send', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  const found = await readMoveSend(ctx.db, 'imp-2');

  expect(found).toBeUndefined();
});

test('#updateMoveSend sets the fields it is given on the imp’s row', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  await updateMoveSend(ctx.db, 'imp-1', {
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
  });

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(found).toMatchObject({ peer_url: 'https://target.test:7071', ticket: 'ticket' });
});

test('#updateMoveSend never changes another imp’s row', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveSendRow({ imp_id: 'imp-2' });

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await writeMoveSend(ctx.db, other);
  await updateMoveSend(ctx.db, 'imp-1', { error: 'the target did not answer' });

  const found = await readMoveSend(ctx.db, 'imp-2');

  expect(found).toStrictEqual(other);
});

test('#updateMoveSendStep moves a prepared send to streaming with its fields', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  await updateMoveSendStep(ctx.db, 'imp-1', 'streaming', {
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
  });

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(found).toMatchObject({
    step: 'streaming',
    peer_url: 'https://target.test:7071',
    ticket: 'ticket',
  });
});

test('#updateMoveSendStep moves a streaming send to sent', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await updateMoveSendStep(ctx.db, 'imp-1', 'streaming');
  await updateMoveSendStep(ctx.db, 'imp-1', 'sent', { receipt: '{}' });

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(found).toMatchObject({ step: 'sent', receipt: '{}' });
});

test('#updateMoveSendStep keeps a streaming send streaming when a resume sends it again', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await updateMoveSendStep(ctx.db, 'imp-1', 'streaming', { ticket: 'first' });
  await updateMoveSendStep(ctx.db, 'imp-1', 'streaming', { ticket: 'second' });

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(found).toMatchObject({ step: 'streaming', ticket: 'second' });
});

test.each([
  ['prepared', 'sent'],
  ['streaming', 'prepared'],
  ['sent', 'streaming'],
  ['sent', 'prepared'],
] as const)('#updateMoveSendStep refuses a send from %s to %s', async (from, to) => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  await ctx.db.updateTable('move_sends').set({ step: from }).execute();

  expect(updateMoveSendStep(ctx.db, 'imp-1', to, { error: 'kept out' })).rejects.toThrow(
    `imp imp-1: the move send cannot go from ${from} to ${to}`,
  );
});

test('#updateMoveSendStep leaves the row as it was when it refuses a step', async () => {
  const ctx = await setupTest();

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));

  const refused = await updateMoveSendStep(ctx.db, 'imp-1', 'sent', { receipt: '{}' }).then(
    () => null,
    (error: unknown) => error,
  );

  const found = await readMoveSend(ctx.db, 'imp-1');

  expect(refused).toBeInstanceOf(Error);
  expect(found).toMatchObject({ step: 'prepared', receipt: null });
});

test('#removeMoveSend removes the imp’s row and keeps another imp’s', async () => {
  const ctx = await setupTest();

  const other = buildMockMoveSendRow({ imp_id: 'imp-2' });

  await writeMoveSend(ctx.db, buildMockMoveSendRow({ imp_id: 'imp-1' }));
  await writeMoveSend(ctx.db, other);
  await removeMoveSend(ctx.db, 'imp-1');

  const rows = await ctx.db.selectFrom('move_sends').selectAll().execute();

  expect(rows).toStrictEqual([other]);
});
