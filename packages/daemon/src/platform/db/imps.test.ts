import { expect, onTestFinished, test } from 'bun:test';
import { sql } from 'kysely';
import { buildMockMoveTicketRow } from '../../../testing/imp-ops/build-mock-move-ticket-row';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { createImage } from './images';
import type { ImpWrite } from './imp-write-feed';
import {
  JAIL_UIDS,
  claimTrustPending,
  countImpsByState,
  countImpsUsingImage,
  createImp,
  createImpInFreeSlot,
  findImpById,
  findImpByName,
  listImps,
  removeIdentityReset,
  removeImp,
  updateImpActivity,
  updateImpCommitted,
  updateImpDisk,
  updateImpMove,
  updateImpSettings,
} from './imps';
import { SlotTakenError } from './slot-taken-error';
import { updateImpState } from './update-imp-state';

test('#createImp returns a creating imp with the defaults for what it leaves out', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({
      name: 'dev',
      imageId: image.id,
      vcpus: 2,
      memoryMib: 2048,
      slot: 0,
      ip: '10.66.0.2',
    }),
  );

  expect(imp).toStrictEqual({
    id: expect.toBeString(),
    name: 'dev',
    imageId: image.id,
    state: 'creating',
    kind: 'user',
    vcpus: 2,
    memoryMib: 2048,
    maxMemoryMib: 2048,
    slot: 0,
    ip: '10.66.0.2',
    createdAt: expect.toBeValidDate(),
    lastActiveAt: expect.toBeValidDate(),
    sleptAt: null,
    holdUntil: null,
    error: null,
    hasOopsHold: false,
    oopsBootId: null,
    pid: null,
    firecrackerVersion: null,
    httpPort: 8080,
    diskBytes: 32 * 1024 ** 3,
    isDiskGrowPending: false,
    publicAuth: null,
    cpu: { limit: null, weight: 100 },
    wakeCount: 0,
    jailUid: JAIL_UIDS.first,
    awakeMs: 0,
    awakeSince: null,
    isIdentityResetPending: false,
    isBackedUp: true,
    isTrustPending: false,
    moveState: null,
  });
});

test('#createImp keeps an imp created with backup off out of backups', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, isBackedUp: false }));

  expect(imp.isBackedUp).toBe(false);
});

test('#createImp keeps the memory a guest may grow to', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, memoryMib: 1024, maxMemoryMib: 4096 }),
  );

  expect(imp.maxMemoryMib).toBe(4096);
});

test('#createImp emits one ImpAdded', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  expect(writes).toStrictEqual([{ kind: 'added', imp }]);
});

test('#createImp rejects a duplicate name with a clash naming the column', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id, slot: 0 }));

  expect(
    createImp(
      ctx.db,
      buildMockNewImp({ name: 'dev', imageId: image.id, slot: 1, ip: '10.66.0.3' }),
    ),
  ).rejects.toMatchObject({ name: 'ImpClashError', column: 'name' });
});

test('#createImp rejects a jail uid another imp holds with a clash naming the column', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  // two creates outside a transaction both read the lowest free uid before
  // either inserts
  const created = await Promise.allSettled([
    createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0, ip: '10.66.0.2' })),
    createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' })),
  ]);

  expect(created).toMatchObject([
    { status: 'fulfilled' },
    { status: 'rejected', reason: { name: 'ImpClashError', column: 'jail_uid' } },
  ]);
});

test('#createImp rejects a duplicate slot with a clash naming the column', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0, ip: '10.66.0.2' }));

  expect(
    createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0, ip: '10.66.9.9' })),
  ).rejects.toMatchObject({ name: 'ImpClashError', column: 'slot' });
});

test('#createImp rejects an imp whose image does not exist', async () => {
  const ctx = await createTestDatabase();

  expect(createImp(ctx.db, buildMockNewImp({ imageId: 'missing' }))).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('#createImp gives each imp the lowest free jail uid', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));

  const second = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }),
  );

  expect(second.jailUid).toBe(JAIL_UIDS.first + 1);
});

test('#createImp gives a destroyed imp’s jail uid to the next imp', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const first = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }));
  await removeImp(ctx.db, first.id);

  const third = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, slot: 2, ip: '10.66.0.4' }),
  );

  const stored = await findImpById(ctx.db, third.id);

  expect(stored?.jailUid).toBe(JAIL_UIDS.first);
});

test('#createImp throws when every jail uid is taken', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await sql`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${JAIL_UIDS.count})
    INSERT INTO imps (id, name, image_id, state, vcpus, memory_mib, slot, ip, created_at,
      last_active_at, jail_uid)
    SELECT 'imp-' || i, 'imp-' || i, ${image.id}, 'stopped', 1, 512, i, 'ip-' || i, 0, 0,
      ${JAIL_UIDS.first} + i
    FROM n`.execute(ctx.db);

  expect(
    createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: JAIL_UIDS.count })),
  ).rejects.toThrowWithMessage(Error, 'every one of the 65536 jail uids is taken');
});

test('#findImpByName finds the imp of that name', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));
  const found = await findImpByName(ctx.db, 'dev');

  expect(found).toStrictEqual(imp);
});

test('#findImpByName finds nothing for a name no imp has', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));

  const found = await findImpByName(ctx.db, 'nope');

  expect(found).toBeUndefined();
});

test('#findImpById finds the imp of that id', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const found = await findImpById(ctx.db, imp.id);

  expect(found).toStrictEqual(imp);
});

test('#listImps lists every imp by name', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ name: 'b', imageId: image.id, slot: 0 }));

  await createImp(
    ctx.db,
    buildMockNewImp({ name: 'a', imageId: image.id, slot: 1, ip: '10.66.0.3' }),
  );

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['a', 'b']);
});

test('#countImpsByState counts the imps in each state that has one', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const running = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 2, ip: '10.66.0.4' }));
  await updateImpState(ctx.db, running.id, { reason: 'booted', state: 'running' });

  const counts = await countImpsByState(ctx.db);

  expect(counts).toStrictEqual(
    new Map([
      ['creating', 2],
      ['running', 1],
    ]),
  );
});

test('#countImpsUsingImage counts the imps of one image', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const other = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));
  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: other.id, slot: 2, ip: '10.66.0.4' }));

  const count = await countImpsUsingImage(ctx.db, image.id);

  expect(count).toBe(2);
});

test('#createImpInFreeSlot puts the imp in the lowest free slot', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 0 }));

  const imp = await createImpInFreeSlot(
    ctx.db,
    { name: 'dev', imageId: image.id, vcpus: 2, memoryMib: 2048 },
    { count: 16, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}` },
  );

  expect(imp).toMatchObject({ slot: 1, ip: '10.66.0.6' });
});

test('#createImpInFreeSlot emits one ImpAdded, once it commits', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const imp = await createImpInFreeSlot(
    ctx.db,
    { name: 'dev', imageId: image.id, vcpus: 2, memoryMib: 2048 },
    { count: 16, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}` },
  );

  expect(writes).toStrictEqual([{ kind: 'added', imp }]);
});

test('#createImpInFreeSlot leaves a slot a live ticket keeps to a new imp', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await ctx.db
    .insertInto('move_tickets')
    .values(buildMockMoveTicketRow({ slot: 0, stream_by: 1_800_000_060_000 }))
    .execute();

  const imp = await createImpInFreeSlot(
    ctx.db,
    { name: 'new', imageId: image.id, vcpus: 2, memoryMib: 2048 },
    {
      count: 4,
      findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}`,
      now: () => 1_800_000_000_000,
    },
  );

  expect(imp.slot).toBe(1);
});

test('#createImpInFreeSlot gives a warm move the slot its own ticket keeps', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await ctx.db
    .insertInto('move_tickets')
    .values(buildMockMoveTicketRow({ name: 'moved', slot: 0, stream_by: Date.now() + 60_000 }))
    .execute();

  const imp = await createImpInFreeSlot(
    ctx.db,
    { name: 'moved', imageId: image.id, vcpus: 2, memoryMib: 2048 },
    { count: 4, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}`, slot: 0 },
  );

  expect(imp.slot).toBe(0);
});

test('#createImpInFreeSlot refuses a warm move a slot an imp holds', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 1, ip: '10.66.0.3' }));

  expect(
    createImpInFreeSlot(
      ctx.db,
      { name: 'moved', imageId: image.id, vcpus: 2, memoryMib: 2048 },
      { count: 4, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}`, slot: 1 },
    ),
  ).rejects.toThrowWithMessage(SlotTakenError, 'slot 1 is taken on this host');
});

test('#createImpInFreeSlot refuses a warm move a slot past this host’s slots', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  expect(
    createImpInFreeSlot(
      ctx.db,
      { name: 'moved', imageId: image.id, vcpus: 2, memoryMib: 2048 },
      { count: 4, findIp: (slot) => `10.66.0.${String(slot * 4 + 2)}`, slot: 4 },
    ),
  ).rejects.toThrowWithMessage(SlotTakenError, 'slot 4 is taken on this host');
});

test('#updateImpActivity records when the imp was last active', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpActivity(ctx.db, imp.id, new Date('2026-10-02T01:00:00Z'));

  const active = await findImpById(ctx.db, imp.id);

  expect(active?.lastActiveAt).toStrictEqual(new Date('2026-10-02T01:00:00Z'));
});

test('#updateImpDisk emits ImpChanged resized for a new disk size', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, diskBytes: 1024 }));

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const sized = await updateImpDisk(ctx.db, imp.id, { diskBytes: 2048, isGrowPending: true });

  expect(writes).toStrictEqual([{ kind: 'changed', imp: sized, reason: 'resized' }]);
});

test('#updateImpDisk emits nothing for a pending grow alone', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, diskBytes: 1024 }));

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await updateImpDisk(ctx.db, imp.id, { diskBytes: 1024, isGrowPending: true });

  expect(writes).toStrictEqual([]);
});

test('#updateImpDisk records a grow the guest still owes', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, diskBytes: 1024 }));
  const sized = await updateImpDisk(ctx.db, imp.id, { diskBytes: 2048, isGrowPending: true });

  expect(sized).toMatchObject({ diskBytes: 2048, isDiskGrowPending: true });
});

test('#updateImpSettings changes the CPU, the vcpus and the port', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, vcpus: 1 }));

  const updated = await updateImpSettings(ctx.db, imp.id, {
    cpu: { limit: 1.5, weight: 200 },
    vcpus: 4,
    httpPort: 3000,
  });

  expect(updated).toMatchObject({ cpu: { limit: 1.5, weight: 200 }, vcpus: 4, httpPort: 3000 });
});

test('#updateImpSettings emits ImpChanged updated', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const updated = await updateImpSettings(ctx.db, imp.id, {
    cpu: { limit: null, weight: 100 },
    vcpus: 2,
    httpPort: 8080,
  });

  expect(writes).toStrictEqual([{ kind: 'changed', imp: updated, reason: 'updated' }]);
});

test('#updateImpCommitted takes the move mark off and commits the imp’s tickets', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, moveState: 'receiving' }),
  );

  await ctx.db
    .insertInto('move_tickets')
    .values(buildMockMoveTicketRow({ id: 'ticket', imp_id: imp.id }))
    .execute();

  const committed = await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000);

  const ticket = await ctx.db
    .selectFrom('move_tickets')
    .select('committed_at')
    .where('id', '=', 'ticket')
    .executeTakeFirstOrThrow();

  expect(committed.moveState).toBeNull();
  expect(ticket.committed_at).toBe(1_800_000_000_000);
});

test('#updateImpCommitted leaves a warm move’s imp asleep on its memory, trust pending', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, moveState: 'receiving' }),
  );

  // a received copy is stopped once its disk is ready
  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });

  const committed = await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000, true);

  expect(committed).toMatchObject({
    state: 'sleeping',
    sleptAt: new Date(1_800_000_000_000),
    isTrustPending: true,
    moveState: null,
  });
});

test('#updateImpCommitted refuses a warm commit the lifecycle table does not list', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, moveState: 'receiving' }),
  );

  await updateImpState(ctx.db, imp.id, { reason: 'failed', state: 'error' });

  expect(updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000, true)).rejects.toMatchObject({
    code: 'INVALID_STATE',
  });
});

test('#updateImpCommitted leaves the move mark on a warm commit it refuses', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, moveState: 'receiving' }),
  );

  await updateImpState(ctx.db, imp.id, { reason: 'failed', state: 'error' });
  await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000, true).catch(() => {});

  const after = await findImpById(ctx.db, imp.id);

  expect(after?.moveState).toBe('receiving');
});

test('#updateImpCommitted leaves a cold move’s imp in its state', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, moveState: 'receiving' }),
  );

  const committed = await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000);

  expect(committed).toMatchObject({ state: 'creating', isTrustPending: false });
});

test('#claimTrustPending claims a pending trust install', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });
  await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000, true);

  const isClaimed = await claimTrustPending(ctx.db, imp.id);

  expect(isClaimed).toBeTrue();
});

test('#claimTrustPending claims a pending trust install only once', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });
  await updateImpCommitted(ctx.db, imp.id, 1_800_000_000_000, true);
  await claimTrustPending(ctx.db, imp.id);

  const isClaimed = await claimTrustPending(ctx.db, imp.id);

  expect(isClaimed).toBeFalse();
});

test('#claimTrustPending claims nothing for an imp with no pending trust install', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const isClaimed = await claimTrustPending(ctx.db, imp.id);

  expect(isClaimed).toBeFalse();
});

test('#removeIdentityReset clears a pending identity reset', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  const imp = await createImp(
    ctx.db,
    buildMockNewImp({ imageId: image.id, isIdentityResetPending: true }),
  );

  const reset = await removeIdentityReset(ctx.db, imp.id);

  expect(reset.isIdentityResetPending).toBeFalse();
});

test('#removeImp reports a removed imp as removed', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const isRemoved = await removeImp(ctx.db, imp.id);

  expect(isRemoved).toBeTrue();
});

test('#removeImp emits one ImpRemoved', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  await removeImp(ctx.db, imp.id);

  expect(writes).toStrictEqual([{ kind: 'removed', imp }]);
});

test('#removeImp reports an imp that is gone already as not removed', async () => {
  const ctx = await createTestDatabase();
  const isRemoved = await removeImp(ctx.db, 'missing');

  expect(isRemoved).toBeFalse();
});

test.each([
  ['an unmarked imp to sending', {}, 'sending'],
  ['a sending imp back to unmarked', { moveState: 'sending' }, null],
  ['a sending imp to moved', { moveState: 'sending' }, 'moved'],
  ['a moved imp back to unmarked', { moveState: 'moved' }, null],
  ['an unmarked imp to receiving', {}, 'receiving'],
  ['a receiving imp to unmarked', { moveState: 'receiving' }, null],
  ['an unmarked imp, left unmarked', {}, null],
  ['a sending imp, left sending', { moveState: 'sending' }, 'sending'],
] as const)('#updateImpMove takes %s', async (_kind, start, to) => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, ...start }));
  const updated = await updateImpMove(ctx.db, imp.id, to);

  expect(updated.moveState).toBe(to);
});

test.each([
  ['an unmarked imp straight to moved', {}, 'moved', 'null to moved'],
  ['a moved imp back to sending', { moveState: 'moved' }, 'sending', 'moved to sending'],
  ['a moved imp to receiving', { moveState: 'moved' }, 'receiving', 'moved to receiving'],
  ['a sending imp to receiving', { moveState: 'sending' }, 'receiving', 'sending to receiving'],
  ['a receiving imp to moved', { moveState: 'receiving' }, 'moved', 'receiving to moved'],
] as const)('#updateImpMove refuses %s and keeps the mark', async (_kind, start, to, change) => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id, ...start }));

  expect(updateImpMove(ctx.db, imp.id, to)).rejects.toThrow(
    `imp ${imp.id}: the move mark cannot go from ${change}`,
  );

  const kept = await findImpById(ctx.db, imp.id);

  expect(kept?.moveState).toBe(imp.moveState);
});
