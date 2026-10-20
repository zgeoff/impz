import { expect, test } from 'bun:test';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { allocateSlot } from './allocate-slot';
import { createImage } from './images';
import { createImp } from './imps';

test('#allocateSlot takes the lowest free slot, reusing a gap', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));
  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 2, ip: '10.66.0.4' }));

  const slot = await allocateSlot(ctx.db, 16);

  expect(slot).toBe(1);
});

test('#allocateSlot gives concurrent creates distinct slots', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imps = await Promise.all(
    ['a', 'b', 'c', 'd'].map((name) =>
      ctx.db.transaction().execute(async (trx) => {
        const slot = await allocateSlot(trx, 16);

        return createImp(
          Object.assign(trx, { writes: ctx.db.writes }),
          buildMockNewImp({ name, imageId: image.id, slot, ip: `10.66.0.${String(slot + 2)}` }),
        );
      }),
    ),
  );

  expect(imps.map((imp) => imp.slot)).toIncludeSameMembers([0, 1, 2, 3]);
});

test('#allocateSlot throws when every slot is taken', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));
  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }));

  expect(allocateSlot(ctx.db, 2)).rejects.toThrowWithMessage(
    Error,
    'every one of the 2 slots is taken',
  );
});

test('#allocateSlot passes over a slot a live ticket keeps', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('move_tickets')
    .values(buildMockMoveTicketRow({ slot: 0, stream_by: 1_800_000_060_000 }))
    .execute();

  const slot = await allocateSlot(ctx.db, 4, 1_800_000_000_000);

  expect(slot).toBe(1);
});

test('#allocateSlot takes a slot whose ticket’s stream window ended unused', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('move_tickets')
    .values(buildMockMoveTicketRow({ slot: 0, stream_by: 1_800_000_060_000 }))
    .execute();

  const slot = await allocateSlot(ctx.db, 4, 1_800_000_120_000);

  expect(slot).toBe(0);
});

test('#allocateSlot passes over a slot whose ticket’s stream started, past its window', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('move_tickets')
    .values(
      buildMockMoveTicketRow({
        slot: 0,
        stream_by: 1_800_000_060_000,
        stream_used_at: 1_800_000_030_000,
      }),
    )
    .execute();

  const slot = await allocateSlot(ctx.db, 4, 1_800_000_120_000);

  expect(slot).toBe(1);
});

test('#allocateSlot takes a slot whose ticket committed', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('move_tickets')
    .values(
      buildMockMoveTicketRow({
        slot: 0,
        stream_by: 1_800_000_060_000,
        stream_used_at: 1_800_000_030_000,
        committed_at: 1_800_000_040_000,
      }),
    )
    .execute();

  const slot = await allocateSlot(ctx.db, 4, 1_800_000_000_000);

  expect(slot).toBe(0);
});
