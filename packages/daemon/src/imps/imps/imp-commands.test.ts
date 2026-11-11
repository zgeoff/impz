import { expect, onTestFinished, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { updateImage } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';
import { startTestImpd } from '../../test-utils/start-test-impd';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack);
}

test('it logs the create of an imp named like an area under the imps area, with the imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'gc' });

  expect(ctx.logs).toContainEqual(expect.toStartWith('INFO impd.imps imp=gc created in '));
  expect(ctx.logs).not.toContainEqual(expect.toInclude(' impd.gc '));
});

test('it keeps the digest an imp cloned from after its image row takes a new digest', async () => {
  const ctx = await setupTest();
  const image = await ctx.createTestImage('ubuntu');

  await ctx.imps.createImp({ name: 'dev' });

  await updateImage(ctx.db, image.id, {
    ref: image.ref,
    digest: `sha256:${'e'.repeat(64)}`,
    sizeBytes: image.sizeBytes,
  });

  const imp = await readImpByName(ctx.db, 'dev');

  expect(imp?.imageDigest).toBe(image.digest);
});

test('it removes the tap an imp booted with when it destroys the imp', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');
  await ctx.imps.createImp({ name: 'dev' });

  const [booted] = ctx.taps;

  invariant(booted !== undefined);

  await ctx.imps.destroyImp('dev');

  expect(ctx.removedTaps).toStrictEqual([booted]);
});

test('it keeps the imp’s id through a sleep and a wake', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('ubuntu');

  const created = await ctx.imps.createImp({ name: 'dev' });
  const slept = await ctx.imps.sleepImp('dev');
  const woken = await ctx.imps.wakeImp('dev');
  const record = await readImpByName(ctx.db, 'dev');

  expect([slept.state, woken.state]).toStrictEqual(['sleeping', 'running']);
  expect([slept.id, woken.id, record?.id]).toStrictEqual([created.id, created.id, created.id]);
});
