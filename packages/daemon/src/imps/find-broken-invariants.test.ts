import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { listImps } from '../db/imps';
import { findBrokenInvariants } from './find-broken-invariants';
import { createImpTest } from './test-imps';

test('#findBrokenInvariants finds nothing wrong with a running imp and its VM', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual([]);
});

test('#findBrokenInvariants reports a VM that runs for no running imp', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  const pid = harness.fake.spawnOrphan();

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual([`VM ${String(pid)} runs for no running imp`]);
});

test('#findBrokenInvariants reports a running imp whose VM died once liveness ran', async () => {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await createImpTest(stack);

  await harness.createTestImage('ubuntu');
  await harness.imps.createImp({ name: 'dev' });

  const [imp] = await listImps(harness.db);

  invariant(typeof imp?.pid === 'number');

  harness.fake.alive.delete(imp.pid);

  const broken = await findBrokenInvariants(harness, true);

  expect(broken).toStrictEqual(['dev (running): its VM is dead']);
});
