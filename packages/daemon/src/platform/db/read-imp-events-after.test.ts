import { expect, test } from 'bun:test';
import { appendEvent, pruneEvents } from '@impz/durable';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { buildMockNewImp } from '../../test-utils/imps/build-mock-new-imp';
import { createTestDatabase } from '../../test-utils/platform/create-test-database';
import { createImage } from './images';
import { createImp, removeImp } from './imps';
import { readImpEventsAfter } from './read-imp-events-after';

function setupTest() {
  return createTestDatabase();
}

test('it reads each event after the cursor back with its seq and time', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await removeImp(ctx.db, imp.id);

  const read = await readImpEventsAfter(ctx.db, { after: 1, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [{ ev: 'ImpRemoved', imp, seq: 2, at: expect.any(Date) }],
    throughSeq: 2,
    hasMore: false,
  });
});

test('it skips a row it cannot read and moves the cursor past it', async () => {
  const ctx = await setupTest();

  await appendEvent(ctx.db, {
    at: 1_800_000_000_000,
    kind: 'operation.started',
    targetId: null,
    operationId: 'op-1',
    payload: { kind: 'create' },
  });

  const read = await readImpEventsAfter(ctx.db, { after: 0, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [],
    throughSeq: 1,
    hasMore: false,
  });
});

test('it reports more to read when the read fills its limit', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ name: 'first-imp', imageId: image.id, slot: 0 }));

  await createImp(
    ctx.db,
    buildMockNewImp({ name: 'second-imp', imageId: image.id, slot: 1, ip: '10.66.0.6' }),
  );

  const read = await readImpEventsAfter(ctx.db, { after: 0, limit: 1 });

  expect(read).toStrictEqual({
    kind: 'events',
    events: [expect.objectContaining({ ev: 'ImpAdded', seq: 1 })],
    throughSeq: 1,
    hasMore: true,
  });
});

test('it reports a reset for a cursor a prune passed', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await ctx.db.transaction().execute((trx) => pruneEvents(trx, Date.now() + 8 * 86_400_000));

  const read = await readImpEventsAfter(ctx.db, { after: 0, limit: 10 });

  expect(read).toStrictEqual({
    kind: 'reset',
    prunedThrough: 1,
  });
});
