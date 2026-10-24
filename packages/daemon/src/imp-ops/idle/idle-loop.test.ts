import { expect, onTestFinished, test } from 'bun:test';
import { buildMockLeaseRecord } from '../../../testing/imps/build-mock-lease-record';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { startTestImpd } from '../../../testing/start-test-impd';
import { createImage } from '../../platform/db/images';
import { readImpByName, updateImpActivity } from '../../platform/db/imps';
import { writeLease } from '../../platform/db/leases';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createIdleLoop } from './idle-loop';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack, { frozenClockMs: Date.UTC(2026, 0, 1) });
}

test('it holds the imp until the end of its earlier lease once the later lease is released', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a' };

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'early', until: new Date(at + 60_000) }),
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'late', until: new Date(at + 600_000) }),
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  const held = await readImpByName(ctx.db, 'dev');

  expect(held?.holdUntil).toStrictEqual(new Date(at + 60_000));
});

test('it reports that it released a lease the caller held', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({
      impId: imp.id,
      principal: 'token:a',
      display: 'a',
      label: 'late',
      until: new Date(at + 600_000),
    }),
    { at, reason: 'held' },
  );

  const released = await ctx.impd.imps.releaseLease(
    'dev',
    { principal: 'token:a', display: 'a' },
    'late',
  );

  expect(released).toBeTrue();
});

test('it keeps an idle imp awake while the earlier of its leases runs', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a' };

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'early', until: new Date(at + 60_000) }),
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'late', until: new Date(at + 600_000) }),
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  await updateImpActivity(ctx.db, imp.id, new Date(at - 60_000));

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 1 },
    db: ctx.db,
    imps: ctx.impd.imps,
    now: ctx.now,
    readCpuTicks: () => null,
  });

  await idle.runCheck();

  const checked = await readImpByName(ctx.db, 'dev');

  expect(checked?.state).toBe('running');
});

test('it sleeps an idle imp once the earlier of its leases has ended', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const imp = await ctx.impd.imps.createImp({ name: 'dev' });

  const at = ctx.now();
  const lease = { impId: imp.id, principal: 'token:a', display: 'a' };

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'early', until: new Date(at + 60_000) }),
    { at, reason: 'held' },
  );

  await writeLease(
    ctx.db,
    buildMockLeaseRecord({ ...lease, label: 'late', until: new Date(at + 600_000) }),
    { at, reason: 'held' },
  );

  await ctx.impd.imps.releaseLease('dev', { principal: 'token:a', display: 'a' }, 'late');

  await updateImpActivity(ctx.db, imp.id, new Date(at - 60_000));

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 1 },
    db: ctx.db,
    imps: ctx.impd.imps,
    now: ctx.now,
    readCpuTicks: () => null,
  });

  ctx.advance(60_000 + 1);

  await idle.runCheck();

  const checked = await readImpByName(ctx.db, 'dev');

  expect(checked?.state).toBe('sleeping');
});
