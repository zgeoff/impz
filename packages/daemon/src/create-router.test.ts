import { expect, onTestFinished, test } from 'bun:test';
import { buildMockNewImage } from '../testing/imps/build-mock-new-image';
import { startTestImpd } from '../testing/start-test-impd';
import { createImage } from './db/images';
import { readImpByName } from './db/imps';
import { buildImagePaths } from './storage/data-layout';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return {
    db: harness.db,
    dataDir: harness.dataDir,
    impd: harness.impd,
    client: harness.client,
  };
}

test('#imps.setPolicy refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const setting = ctx.client.imps.setPolicy({
    name: 'imp-build-x',
    policy: { mode: 'open', allow: [] },
  });

  expect(setting).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#exec.ticket refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const ticketing = ctx.client.exec.ticket({ name: 'imp-build-x' });

  expect(ticketing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.fork refuses a builder as its source', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const forking = ctx.client.imps.fork({ source: 'imp-build-x', name: 'copy' });

  expect(forking).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.stop refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const stopping = ctx.client.imps.stop({ name: 'imp-build-x' });

  expect(stopping).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#checkpoints.create refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const checkpointing = ctx.client.checkpoints.create({ name: 'imp-build-x' });

  expect(checkpointing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#images.add refuses a template of a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const adding = ctx.client.images.add({ imp: 'imp-build-x', name: 'tpl' });

  expect(adding).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#moves.prepare refuses a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const preparing = ctx.client.moves.prepare({ name: 'imp-build-x' });

  expect(preparing).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('#imps.list leaves out a builder unless the caller asks for builders', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const listed = await ctx.client.imps.list();

  expect(listed.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('#imps.list lists a builder when the caller asks for builders', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });

  const all = await ctx.client.imps.list({ builders: true });

  expect(all.map((imp) => [imp.name, imp.kind])).toStrictEqual([
    ['dev', 'user'],
    ['imp-build-x', 'builder'],
  ]);
});

test('#imps.get shows a builder by its name as a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const info = await ctx.client.imps.get({ name: 'imp-build-x' });

  expect(info.kind).toBe('builder');
});

test('#imps.destroy removes a builder', async () => {
  const ctx = await setupTest();

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });
  await ctx.client.imps.destroy({ name: 'imp-build-x' });

  const gone = await readImpByName(ctx.db, 'imp-build-x');

  expect(gone).toBeUndefined();
});
