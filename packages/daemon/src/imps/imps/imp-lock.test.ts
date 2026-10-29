import { expect, mock, onTestFinished, test } from 'bun:test';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { startTestImpd } from '../../../testing/start-test-impd';
import { createImp, updateImpMove } from '../../platform/db/imps';
import { createCpuCgroups } from '../../vm/vmm/cpu-cgroups';
import { createImpContext } from './imp-context';
import { createImpLock } from './imp-lock';
import { NO_KERNEL_OOPS } from './kernel-oops-watch';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {});

  const context = createImpContext({
    config: harness.config,
    db: harness.db,
    images: harness.images,

    taps: { setupTap: () => Promise.resolve(), removeTap: () => Promise.resolve() },
    admission: { admit: () => Promise.resolve(), release: () => {} },
    vms: harness.fake.startGeneration(),
    storage: harness.storage,
    identity: harness.readIdentity(),
    storageGate: harness.storageGate,
    cgroups: createCpuCgroups({ root: '/nonexistent' }),
    hostCpus: 8,
    readRamMib: () => null,
    readRssMib: () => null,
    readVmMemory: () => ({ ramMib: null, rssMib: null }),
    readUnsharedRamMib: () => null,
    checkGuestMerge: () => Promise.resolve(null),
    probeUffdDevice: () => false,
    growFilesystem: () => Promise.resolve(false),
    sleep: () => Promise.resolve(),
    sleepTiming: { now: () => 0, sleep: () => Promise.resolve() },
    kernelOops: NO_KERNEL_OOPS,
    readThreadIds: () => null,
    readNetBytes: () => null,
  });

  return {
    db: harness.db,
    createTestImage: harness.createTestImage,
    lock: createImpLock(context),
  };
}

test('#withImp refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'dev', imageId: image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const action = mock(() => Promise.resolve());

  expect(ctx.lock.withImp('dev', action)).rejects.toMatchObject({ code: 'MOVING' });
});

test('#withImpId refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const action = mock(() => Promise.resolve());
  const refusal = ctx.lock.withImpId(imp.id, action);

  expect(refusal).rejects.toMatchObject({ code: 'MOVING' });
  expect(action).not.toHaveBeenCalled();
});

test("#withImpId runs the move's own call on a moving imp", async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpMove(ctx.db, imp.id, 'sending');

  const seen = await ctx.lock.withImpId(imp.id, (locked) => Promise.resolve(locked?.moveState), {
    isMove: true,
  });

  expect(seen).toBe('sending');
});

test('#withImpId runs on an imp that is not moving', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const seen = await ctx.lock.withImpId(imp.id, (locked) => Promise.resolve(locked?.id));

  expect(seen).toBe(imp.id);
});

test('#tryWithImpId refuses an imp whose move is in flight', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpMove(ctx.db, imp.id, 'receiving');

  const action = mock(() => Promise.resolve());

  const result = await ctx.lock.tryWithImpId(imp.id, action);

  expect(result).toStrictEqual({ ran: false });
  expect(action).not.toHaveBeenCalled();
});

test("#tryWithImpId runs the move's own call on a moving imp", async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpMove(ctx.db, imp.id, 'receiving');

  const result = await ctx.lock.tryWithImpId(
    imp.id,
    (locked) => Promise.resolve(locked?.moveState),
    { isMove: true },
  );

  expect(result).toStrictEqual({ ran: true, value: 'receiving' });
});

test('#tryWithImpId runs on an imp that is not moving', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const result = await ctx.lock.tryWithImpId(imp.id, (locked) => Promise.resolve(locked?.id));

  expect(result).toStrictEqual({ ran: true, value: imp.id });
});
