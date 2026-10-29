import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '../../../testing/start-test-impd';
import { updateImage } from '../../platform/db/images';
import { readImpByName } from '../../platform/db/imps';

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
