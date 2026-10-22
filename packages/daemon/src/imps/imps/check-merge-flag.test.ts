import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../../../testing/start-test-impd';
import type { TestImpdOptions } from '../../../testing/start-test-impd';
import { readSnapshotMeta } from '../../vm/sleep/snapshot-meta';
import { buildImpPaths } from '../../vm/storage/data-layout';

function setupTest(
  options: Pick<
    TestImpdOptions,
    'env' | 'readUnsharedRamMib' | 'checkGuestMerge' | 'readKsmProfitMib' | 'readKsmHostStats'
  > = {},
) {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack, options);
}

test('it reports no KSM in system info without IMP_KSM', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm).toBeNull();
});

test('it records the unshared size for the wake reserve on a sleep with IMP_KSM', async () => {
  const ctx = await setupTest({ env: { IMP_KSM: '1' }, readUnsharedRamMib: () => 400 });

  await ctx.createTestImage('base');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(buildImpPaths(ctx.dataDir, created.id));

  expect(meta?.ramMib).toBe(400);
});

test('it records the Pss on a sleep without IMP_KSM', async () => {
  const ctx = await setupTest({ readUnsharedRamMib: () => 400 });

  await ctx.createTestImage('base');

  const created = await ctx.client.imps.create({ name: 'dev' });

  await ctx.client.imps.sleep({ name: 'dev' });

  const meta = readSnapshotMeta(buildImpPaths(ctx.dataDir, created.id));

  expect(meta?.ramMib).toBe(300);
});

test('it shows the saving, the headroom and the unmergeable imps in system info', async () => {
  const ctx = await setupTest({
    env: { IMP_KSM: '1', IMP_KSM_HEADROOM_PERCENT: '50' },
    checkGuestMerge: () => Promise.resolve(false),
    readKsmProfitMib: () => Promise.resolve(60),
    readKsmHostStats: () => ({ running: true, sharedMib: 120, profitMib: 100, zeroMib: 4 }),
  });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm).toStrictEqual({
    running: true,
    sharedMib: 120,
    profitMib: 100,
    zeroMib: 4,
    headroomMib: 30,
    unmergeable: 1,
  });
});

test('it logs an imp whose VM KSM cannot merge', async () => {
  const ctx = await setupTest({
    env: { IMP_KSM: '1' },
    checkGuestMerge: () => Promise.resolve(false),
  });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.system.info();

  expect(ctx.logs).toSatisfyAny((line: string) => line.includes('KSM cannot merge'));
});

test('it counts a merge flag impd cannot read as mergeable', async () => {
  const ctx = await setupTest({
    env: { IMP_KSM: '1' },
    checkGuestMerge: () => Promise.resolve(null),
    readKsmHostStats: () => ({ running: true, sharedMib: 120, profitMib: 100, zeroMib: 4 }),
  });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  const info = await ctx.client.system.info();

  expect(info.ksm?.unmergeable).toBe(0);
});

test('it logs a merge flag impd cannot read', async () => {
  const ctx = await setupTest({
    env: { IMP_KSM: '1' },
    checkGuestMerge: () => Promise.resolve(null),
  });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.client.system.info();

  expect(ctx.logs).toSatisfyAny((line: string) => line.includes('cannot read whether KSM'));
});

test('it logs nothing about the merge flag when impd itself started the VM without IMP_KSM', async () => {
  const ctx = await setupTest({ checkGuestMerge: () => Promise.resolve(true) });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });

  expect(ctx.logs).not.toSatisfyAny((line: string) => line.includes('keeps the KSM merge flag'));
});

test('it logs an adopted VM that keeps the merge flag without IMP_KSM once', async () => {
  const ctx = await setupTest({ checkGuestMerge: () => Promise.resolve(true) });

  await ctx.createTestImage('base');
  await ctx.client.imps.create({ name: 'dev' });
  await ctx.restartImpd();

  expect(ctx.logs.filter((line) => line.includes('keeps the KSM merge flag'))).toStrictEqual([
    'impd: dev: its VM keeps the KSM merge flag with IMP_KSM off, until the imp restarts',
  ]);
});
