import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import invariant from 'tiny-invariant';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { startTestImpd } from '../../../testing/start-test-impd';
import { listColdBoots } from '../../platform/db/cold-boots';
import { readImpByName } from '../../platform/db/imps';
import { buildImpPaths, buildWatchdogSlot } from '../../vm/storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    frozenClockMs: Date.UTC(2026, 0, 1),
  });

  return harness;
}

test('it marks since when the agent is silent and keeps the imp running under report', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'report');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');
  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(imp.state).toBe('running');
  expect(imp.agentSilentSince).toBeInstanceOf(Date);
  expect(ctx.fake.alive.has(created.pid)).toBeTrue();
});

test('it kills the VM and boots the imp cold under restart, saying why', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'restart');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.client.imps.create({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');

  const lines = captureImpdLogs();

  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const imp = await ctx.client.imps.get({ name: 'dev' });

  expect(ctx.fake.alive.has(created.pid)).toBeFalse();
  expect(ctx.fake.stops).toStrictEqual([{ pid: created.pid, graceful: false }]);
  expect(imp.state).toBe('running');
  expect(imp.coldBootReason).toBe('the watchdog restarted it: its agent stopped answering');
  expect(imp).not.toHaveProperty('agentSilentSince');
  expect(lines).toContain('INFO impd.imps imp=dev the watchdog booted it cold');
});

test('it logs why a restart failed under restart when the cold boot fails', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'restart');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');
  ctx.fake.queue('boot', 'fail');

  const lines = captureImpdLogs();

  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  expect(lines).toStrictEqual([
    'WARNING impd.imps imp=dev the agent has not answered for 11s; its VM still runs (watchdog: restart)',
    String.raw`INFO impd.imps imp=dev boot failed: no agent\nlog tail`,
    String.raw`WARNING impd.imps imp=dev the watchdog restart failed: boot failed: no agent\nlog tail`,
  ]);
});

test('it records a watchdog restart as the cause of a cold boot', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'restart');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(created);

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');
  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(boots.map((boot) => boot.cause)).toStrictEqual(['watchdog', 'start']);
});

test('it writes the memory to the owner-only watchdog slot under snapshot, then boots cold', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'snapshot');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');

  const lines = captureImpdLogs();

  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).directory);

  const imp = await readImpByName(ctx.db, 'dev');
  const boots = await listColdBoots(ctx.db, created.id);

  expect(lines).toContain(
    `INFO impd.imps imp=dev the watchdog kept its memory in ${slot.snapshotDir}`,
  );

  expect(statSync(slot.snapshotDir).mode & 0o777).toBe(0o700);
  expect(statSync(slot.memFile).mode & 0o777).toBe(0o600);
  expect(statSync(slot.snapshotMeta).mode & 0o777).toBe(0o600);
  expect(imp?.state).toBe('running');
  expect(ctx.fake.alive.has(created.pid)).toBeFalse();
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['watchdog', 'start']);
});

test('it removes the watchdog slot with a destroyed imp', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'snapshot');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(created);

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');
  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();
  await ctx.impd.imps.destroyImp('dev');

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).directory);

  expect(existsSync(slot.snapshotDir)).toBeFalse();
});

test('it boots the imp cold with no slot under snapshot when the disk has no room', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'snapshot');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.diskUsage.availableBytes = 4 * 1024 ** 3;

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');

  const lines = captureImpdLogs();

  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const imp = await readImpByName(ctx.db, 'dev');

  const slot = buildWatchdogSlot(buildImpPaths(ctx.dataDir, created.id).directory);

  expect(lines).toContain(
    'WARNING impd.imps imp=dev no watchdog snapshot: not enough free disk: 4.0 GiB free, 2.0 GiB wanted, and 5.0 GiB is held in reserve (IMP_DISK_RESERVE_GIB)',
  );

  expect(existsSync(slot.snapshotDir)).toBeFalse();
  expect(imp?.state).toBe('running');
  expect(ctx.fake.alive.has(created.pid)).toBeFalse();
});

test('it keeps the VM under restart when the agent answers again under the lock', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'restart');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  ctx.impd.imps.watchdog.observe(created, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'ok');

  const lines = captureImpdLogs();

  ctx.impd.imps.watchdog.observe(created, false);

  await ctx.impd.imps.watchdog.settle();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(ctx.fake.alive.has(created.pid)).toBeTrue();
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start']);

  expect(lines).toStrictEqual([
    'WARNING impd.imps imp=dev the agent has not answered for 11s; its VM still runs (watchdog: restart)',
    'INFO impd.imps imp=dev its agent answers again; the watchdog stands down',
  ]);
});

test('it leaves alone under restart a VM that a sleep and a wake replaced during the ping', async () => {
  updateEnv('IMP_WATCHDOG_ACTION', 'restart');
  updateEnv('IMP_WATCHDOG_TIMEOUT_S', '10');

  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.impd.imps.createImp({ name: 'dev' });

  const created = await readImpByName(ctx.db, 'dev');

  invariant(typeof created?.pid === 'number');

  const seen = { ...created, pid: created.pid + 1000 };

  ctx.impd.imps.watchdog.observe(seen, false);
  ctx.advance(11_000);
  ctx.fake.queue('agentReady', 'fail', 'fail');
  ctx.impd.imps.watchdog.observe(seen, false);

  await ctx.impd.imps.watchdog.settle();

  const boots = await listColdBoots(ctx.db, created.id);

  expect(ctx.fake.alive.has(created.pid)).toBeTrue();
  expect(boots.map((boot) => boot.cause)).toStrictEqual(['start']);
});
