import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { startTestImpd } from '../../../testing/start-test-impd';
import { createImp, readImpById } from '../../platform/db/imps';
import { updateImpState } from '../../platform/db/update-imp-state';
import { createCpuCgroups } from '../../vm/vmm/cpu-cgroups';
import { createImpContext } from './imp-context';
import { createImpLock } from './imp-lock';
import { NO_KERNEL_OOPS } from './kernel-oops-watch';
import { updateLockedImpState } from './update-locked-imp-state';

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

test('it moves a creating imp to stopped', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const stopped = await ctx.lock.withImpId(imp.id, (locked) => {
    invariant(locked);

    return updateLockedImpState(ctx.db, locked, { reason: 'stopped', state: 'stopped' });
  });

  expect(stopped.state).toBe('stopped');
});

test('it refuses a move the lifecycle table does not list', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  await updateImpState(ctx.db, imp.id, { reason: 'stopped', state: 'stopped' });

  const refusal = ctx.lock.withImpId(imp.id, (locked) => {
    invariant(locked);

    return updateLockedImpState(ctx.db, locked, { reason: 'slept', state: 'sleeping' });
  });

  expect(refusal).rejects.toMatchObject({
    code: 'INVALID_STATE',
    data: { state: 'stopped', allowed: ['running'] },
  });
});

test('it refuses a record kept past the callback that held its lock', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));
  const kept = await ctx.lock.withImpId(imp.id, (locked) => Promise.resolve(locked));

  invariant(kept);

  const refusal = updateLockedImpState(ctx.db, kept, { reason: 'stopped', state: 'stopped' });

  expect(refusal).rejects.toThrow(/a state write needs the imp's lock/u);
});

test("it refuses a record read without the imp's lock", async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');
  const imp = await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  // @ts-expect-error a plain record is no LockedImp: the type refuses it too
  const refusal = updateLockedImpState(ctx.db, imp, { reason: 'stopped', state: 'stopped' });

  expect(refusal).rejects.toThrow(/a state write needs the imp's lock/u);

  const unchanged = await readImpById(ctx.db, imp.id);

  expect(unchanged?.state).toBe('creating');
});
