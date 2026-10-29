import { expect, onTestFinished, test } from 'bun:test';
import { waitFor } from '@impz/test-utils/wait-for';
import { startTestImpd } from '../../../testing/start-test-impd';
import { updateImpMove } from '../../platform/db/imps';
import { makePresenceCheck } from './wire-tailnet-names';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, {});

  return Object.assign(harness, { isImpPresent: makePresenceCheck(harness.imps, harness.db) });
}

test('it finds an imp present while another job holds its lock, without waiting on it', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'box' });

  const gate = Promise.withResolvers<void>();

  onTestFinished(() => {
    gate.resolve();
  });

  const holding = ctx.imps.lockImp('box', () => gate.promise);

  await waitFor(() => {
    expect(ctx.imps.isImpBusy(imp.id)).toBeTrue();
  });

  const isPresent = await ctx.isImpPresent('box');

  gate.resolve();

  await holding;

  expect(isPresent).toBeTrue();
});

test('it finds an idle imp present', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');
  await ctx.imps.createImp({ name: 'box' });

  const isPresent = await ctx.isImpPresent('box');

  expect(isPresent).toBeTrue();
});

test('it finds no imp by a name no imp has', async () => {
  const ctx = await setupTest();
  const isPresent = await ctx.isImpPresent('gone');

  expect(isPresent).toBeFalse();
});

test('it finds a moving imp present while the move sends', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'box' });

  await updateImpMove(ctx.db, imp.id, 'sending');

  const isPresent = await ctx.isImpPresent('box');

  expect(isPresent).toBeTrue();
});

test('it finds a moved imp absent', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base');

  const imp = await ctx.imps.createImp({ name: 'box' });

  await updateImpMove(ctx.db, imp.id, 'sending');
  await updateImpMove(ctx.db, imp.id, 'moved');

  const isPresent = await ctx.isImpPresent('box');

  expect(isPresent).toBeFalse();
});
