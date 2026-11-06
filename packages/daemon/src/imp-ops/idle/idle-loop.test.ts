import { expect, onTestFinished, test } from 'bun:test';
import { buildStubAnswerQueue } from '@impz/shared/test-utils/build-stub-answer-queue';
import { createForwardedPeers } from '../../network/proxy/forwarded-peers';
import { startWakeProxy } from '../../network/proxy/wake-proxy';
import { createImage } from '../../platform/db/images';
import { readImpByName, updateImpActivity } from '../../platform/db/imps';
import { writeLease } from '../../platform/db/leases';
import { buildMockLeaseRecord } from '../../test-utils/imps/build-mock-lease-record';
import { buildMockNewImage } from '../../test-utils/imps/build-mock-new-image';
import { seedLoopbackImp } from '../../test-utils/imps/seed-loopback-imp';
import { startStubHeaderEcho } from '../../test-utils/network/start-stub-header-echo';
import { startTestImpd } from '../../test-utils/start-test-impd';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createIdleLoop } from './idle-loop';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { frozenClockMs: Date.UTC(2026, 0, 1) });

  // assigned, not spread: a spread reads the harness's parts once
  return Object.assign(harness, { stack });
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

test('it moves the last active time of a busy guest and leaves its last request time unset', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  await ctx.impd.imps.createImp({ name: 'dev' });

  const ticks = buildStubAnswerQueue([0, 100]);

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 1, idleCpuPercent: 10 },
    db: ctx.db,
    imps: ctx.impd.imps,
    now: ctx.now,
    readCpuTicks: () => ticks.next(),
  });

  await idle.runCheck();

  ctx.advance(1000);

  await idle.runCheck();

  const checked = await readImpByName(ctx.db, 'dev');

  expect({
    lastActiveAt: checked?.lastActiveAt,
    lastRequestAt: checked?.lastRequestAt,
  }).toStrictEqual({ lastActiveAt: new Date(ctx.now()), lastRequestAt: null });
});

test('it moves the last request time while a proxied WebSocket stays open with no new request', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const upstream = startStubHeaderEcho(ctx.stack);

  const proxy = startWakeProxy({
    config: ctx.config,
    db: ctx.db,
    imps: ctx.impd.imps,
    peers: createForwardedPeers(Date.now),
    ports: { proxy: 0, slot: () => 0 },
  });

  ctx.stack.defer(() => proxy.stop());

  const imp = await seedLoopbackImp(
    { db: ctx.db, imps: ctx.impd.imps },
    { name: 'web', httpPort: upstream.port },
  );

  await proxy.syncListeners();

  const socket = new WebSocket(`ws://127.0.0.1:${String(proxy.readImpPort(imp.id))}/`);

  onTestFinished(() => {
    socket.close();
  });

  await new Promise((resolve) => {
    socket.addEventListener('open', resolve);
  });

  const idle = createIdleLoop({
    config: { ...ctx.config, idleTimeoutS: 60 },
    db: ctx.db,
    imps: ctx.impd.imps,
    now: ctx.now,
    readCpuTicks: () => null,
  });

  ctx.advance(30 * 60_000);

  await idle.runCheck();

  const checked = await readImpByName(ctx.db, 'web');

  expect({ state: checked?.state, lastRequestAt: checked?.lastRequestAt }).toStrictEqual({
    state: 'running',
    lastRequestAt: new Date(ctx.now()),
  });
});
