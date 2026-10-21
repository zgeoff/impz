import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { createImage } from './images';
import type { ImpWrite } from './imp-write-feed';
import { createImp } from './imps';
import { updateImpState } from './update-imp-state';

test('#updateImpState sets the state and the fields the change names', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const running = await updateImpState(ctx.db, imp.id, {
    reason: 'booted',
    state: 'running',
    pid: 4242,
    firecrackerVersion: 'v1.17.0',
  });

  expect(running).toMatchObject({ state: 'running', pid: 4242, firecrackerVersion: 'v1.17.0' });
});

test('#updateImpState keeps the fields the change leaves out', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, {
    reason: 'slept',
    state: 'sleeping',
    pid: null,
    sleptAt: new Date('2026-10-02T00:00:00Z'),
    firecrackerVersion: 'v1.17.0',
  });

  const failed = await updateImpState(ctx.db, imp.id, {
    reason: 'failed',
    state: 'error',
    error: 'boot timed out',
  });

  expect(failed).toMatchObject({
    state: 'error',
    error: 'boot timed out',
    sleptAt: new Date('2026-10-02T00:00:00Z'),
    firecrackerVersion: 'v1.17.0',
  });
});

test('#updateImpState keeps the oops hold through a change that writes no error', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    error: 'a kernel oops killed firecracker',
    hasOopsHold: true,
  });

  const slept = await updateImpState(ctx.db, imp.id, { reason: 'repaired', state: 'sleeping' });

  expect(slept).toMatchObject({ hasOopsHold: true, error: 'a kernel oops killed firecracker' });
});

test('#updateImpState ends the oops hold with an error write that does not set it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, {
    reason: 'repaired',
    state: 'stopped',
    error: 'a kernel oops killed firecracker',
    hasOopsHold: true,
  });

  const failed = await updateImpState(ctx.db, imp.id, {
    reason: 'failed',
    state: 'error',
    error: 'boot timed out',
  });

  expect(failed).toMatchObject({ hasOopsHold: false, error: 'boot timed out' });
});

test('#updateImpState emits the change with its reason', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const writes: ImpWrite[] = [];

  const unsubscribe = ctx.db.writes.subscribe((write) => {
    writes.push(write);
  });

  onTestFinished(unsubscribe);

  const running = await updateImpState(ctx.db, imp.id, { reason: 'booted', state: 'running' });

  expect(writes).toStrictEqual([{ kind: 'changed', imp: running, reason: 'booted' }]);
});

test('#updateImpState counts a wake', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const woken = await updateImpState(ctx.db, imp.id, { reason: 'woke', state: 'running' });

  expect(woken.wakeCount).toBe(1);
});

test('#updateImpState adds the awake span to the awake time when the imp stops', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const running = await updateImpState(ctx.db, imp.id, { reason: 'booted', state: 'running' });

  invariant(running.awakeSince);

  const stopped = await updateImpState(ctx.db, imp.id, {
    reason: 'stopped',
    state: 'stopped',
    awakeUntil: new Date(running.awakeSince.getTime() + 5000),
  });

  expect(stopped.awakeMs).toBe(5000);
});

test('#updateImpState keeps the awake span of a running imp marked running again as adopted', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const awakeSince = Date.now() - 3_600_000;

  await ctx.db
    .updateTable('imps')
    .set({ state: 'running', awake_since: awakeSince })
    .where('id', '=', imp.id)
    .execute();

  const adopted = await updateImpState(ctx.db, imp.id, { reason: 'adopted', state: 'running' });

  expect(adopted.awakeSince).toStrictEqual(new Date(awakeSince));
});

test('#updateImpState throws for an imp that is not there', async () => {
  const ctx = await createTestDatabase();

  expect(
    updateImpState(ctx.db, 'imp-missing', { reason: 'stopped', state: 'stopped' }),
  ).rejects.toThrow();
});

test('#updateImpState adds no awake time when a repair ends the span before its start', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const running = await updateImpState(ctx.db, imp.id, {
    reason: 'booted',
    state: 'running',
    pid: 42,
  });

  invariant(running.awakeSince);

  const repaired = await updateImpState(
    ctx.db,
    imp.id,
    {
      reason: 'repaired',
      state: 'stopped',
      pid: null,
      awakeUntil: new Date(running.awakeSince.getTime() - 5000),
    },
    { state: 'running', pid: 42 },
  );

  expect(repaired?.awakeMs).toBe(running.awakeMs);
});

test('#updateImpState leaves an expected row whose pid changed first', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'booted', state: 'running', pid: 42 });

  const stale = await updateImpState(
    ctx.db,
    imp.id,
    { reason: 'stopped', state: 'stopped', pid: null },
    { state: 'running', pid: 41 },
  );

  expect(stale).toBeUndefined();
});

test('#updateImpState applies the change while the row matches what it expects', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'booted', state: 'running', pid: 42 });

  const fresh = await updateImpState(
    ctx.db,
    imp.id,
    { reason: 'stopped', state: 'stopped', pid: null },
    { state: 'running', pid: 42 },
  );

  expect(fresh).toMatchObject({ state: 'stopped', pid: null });
});

test('#updateImpState matches an expected row with no pid', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const stopped = await updateImpState(
    ctx.db,
    imp.id,
    { reason: 'stopped', state: 'stopped' },
    { state: 'creating', pid: null },
  );

  expect(stopped?.state).toBe('stopped');
});

test('#updateImpState keeps the firecracker version a compare-and-set write carries', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });

  const running = await updateImpState(
    ctx.db,
    imp.id,
    { reason: 'booted', state: 'running', pid: 42, firecrackerVersion: 'v1.18.2' },
    { state: 'stopped', pid: null },
  );

  expect(running?.firecrackerVersion).toBe('v1.18.2');
});

test('#updateImpState refuses a compare-and-set move the lifecycle table does not list', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });

  expect(
    updateImpState(
      ctx.db,
      imp.id,
      { reason: 'repaired', state: 'sleeping' },
      { state: 'stopped', pid: null },
    ),
  ).rejects.toMatchObject({ code: 'INVALID_STATE' });
});
