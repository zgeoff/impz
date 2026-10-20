import { expect, onTestFinished, test } from 'bun:test';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import { startTestImpd } from '../testing/start-test-impd';
import { listImps } from './db/imps';

// impd on stub VMs, each of which the governor counts at 300 MiB, with the
// image every imp boots from
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  // a frozen clock that moves only with advance, so imps differ in activity
  const harness = await startTestImpd(stack, {
    env: readImpEnv(),
    frozenClockMs: Date.UTC(2026, 0, 1),
  });

  await harness.createTestImage('ubuntu');

  return harness;
}

test('it skips a victim whose lock another boot holds instead of waiting for it', async () => {
  // two awake imps of 300 MiB; making room for 600 MiB needs both asleep
  updateEnv('IMP_RAM_BUDGET_MIB', '800');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'b' });

  const gate = ctx.fake.hold('sleep');

  // the governor holds admission while it sleeps `a`
  const admitting = ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 600, memoryMib: 600 });

  await gate.reached;

  // a restore of `b`: it takes b's lock, halts it and boots it, which asks
  // the governor for admission
  const restoring = ctx.imps.lockImp('b', async (imp) => {
    const halted = await ctx.imps.haltImp(imp);

    return ctx.imps.bootImp(halted);
  });

  await waitFor(() => {
    expect(ctx.fake.stops).toHaveLength(1);
  });

  gate.release();

  const [admitted, restored] = await Promise.allSettled([admitting, restoring]);

  expect(admitted.status).toBe('fulfilled');

  // the admission took the room the restore's boot asks for
  expect(restored).toMatchObject({ status: 'rejected', reason: { code: 'RAM_BUDGET_EXCEEDED' } });
});

test('it stops sleeping imps for a rejected admit once a sleep fails', async () => {
  // 900 MiB awake + 900 reserved: 800 missing, so the pick is a, b and c
  updateEnv('IMP_RAM_BUDGET_MIB', '1000');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  // awake imps, from the least recently active
  await ctx.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'c' });

  ctx.fake.queue('sleep', 'ok', 'fail');

  expect(
    ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 }),
  ).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  // 500 MiB still missing and only c left: c is not slept for nothing
  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  expect(ctx.fake.alive.size).toBe(2);
});

test('it stops sleeping imps for a rejected admit once the lock of a victim is taken', async () => {
  // 900 MiB awake + 900 reserved: 800 missing, so the pick is a, b and c
  updateEnv('IMP_RAM_BUDGET_MIB', '1000');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'c' });

  // b's lock is taken while a sleeps, after the pick of a, b and c, and stays
  // taken until the admit is done
  const sleeping = ctx.fake.hold('sleep');
  const admitting = ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  await sleeping.reached;

  const locked = Promise.withResolvers<void>();
  const unlock = Promise.withResolvers<void>();

  onTestFinished(() => {
    unlock.resolve();
  });

  const locking = ctx.imps.lockImp('b', () => {
    locked.resolve();

    return unlock.promise;
  });

  await locked.promise;

  sleeping.release();

  expect(admitting).rejects.toMatchObject({ code: 'RAM_BUDGET_EXCEEDED' });

  unlock.resolve();

  await locking;

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'running'],
  ]);

  expect(ctx.fake.alive.size).toBe(2);
});

test('it picks again past a failed sleep and fits an admit when the rest is enough', async () => {
  // 1200 MiB awake + 900 reserved: 800 missing; without b, c and d cover it
  updateEnv('IMP_RAM_BUDGET_MIB', '1300');
  updateEnv('IMP_DEFAULT_MEMORY_MIB', '512');

  const ctx = await setupTest();

  await ctx.imps.createImp({ name: 'a' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'b' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'c' });

  ctx.advance(1000);

  await ctx.imps.createImp({ name: 'd' });

  ctx.fake.queue('sleep', 'ok', 'fail');

  await ctx.governor.admit({ id: 'x', name: 'x', reserveMib: 900, memoryMib: 900 });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.name, imp.state])).toStrictEqual([
    ['a', 'sleeping'],
    ['b', 'running'],
    ['c', 'sleeping'],
    ['d', 'sleeping'],
  ]);
});
