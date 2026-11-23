import { expect, onTestFinished, spyOn, test } from 'bun:test';
import { startTestImpd } from '@impz/testing/stand-in/start-test-impd';
import { createImage } from '../platform/db/create-image';
import { buildMockNewImage } from '../test-utils/imps/build-mock-new-image';
import { buildImagePaths } from '../vm/storage/build-imp-paths';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return {
    db: harness.db,
    impd: harness.impd,
    client: harness.client,
    buildClient: harness.buildClient,
    createTestImage: async (overrides: Parameters<typeof buildMockNewImage>[0] = {}) => {
      const image = buildMockNewImage({ sizeBytes: 6, ...overrides });

      await Bun.write(buildImagePaths(harness.dataDir, image.digest).rootfs, 'rootfs');

      return createImage(harness.db, image);
    },
  };
}

test('#imps.create makes an imp from the image an alias points at', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage({ name: 'base-1', digest: 'sha256:base-1' });
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const imp = await ctx.client.imps.create({ name: 'dev', image: 'agent' });

  expect(imp.image).toBe('base-1');
});

test('#imps.create gives an existing imp the image it was made from after the alias moves', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage({ name: 'base-1', digest: 'sha256:base-1' });
  await ctx.createTestImage({ name: 'base-2', digest: 'sha256:base-2' });
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });
  await ctx.client.imps.create({ name: 'old', image: 'agent' });
  await ctx.client.images.alias({ alias: 'agent', image: 'base-2' });
  await ctx.client.imps.create({ name: 'new', image: 'agent' });

  const [old, current] = await Promise.all([
    ctx.client.imps.get({ name: 'old' }),
    ctx.client.imps.get({ name: 'new' }),
  ]);

  expect([old.image, current.image]).toStrictEqual(['base-1', 'base-2']);
});

test('#imps.create checks a scoped caller and creates from one resolved record', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage({ name: 'base-1', digest: 'sha256:base-1' });

  await ctx.createTestImage({
    name: 'tpl',
    digest: 'sha256:tpl',
    source: 'imp',
    sourceImp: 'secret',
  });

  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  // the alias moves to a template the token may not copy as soon as the route has resolved it
  const images = ctx.impd.images;
  const resolveImage = images.resolveImage;

  const spy = spyOn(images, 'resolveImage').mockImplementation(async (name) => {
    const image = await resolveImage(name);

    await images.updateImageAlias('agent', 'tpl');

    return image;
  });

  onTestFinished(() => {
    spy.mockRestore();
  });

  const imp = await ctx.buildClient(made.secret).imps.create({ name: 'dev-a', image: 'agent' });

  expect(imp.image).toBe('base-1');
});

test('#imps.create refuses a scoped caller the template an alias points at', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage({
    name: 'tpl',
    digest: 'sha256:tpl',
    source: 'imp',
    sourceImp: 'secret',
  });

  await ctx.client.images.alias({ alias: 'agent', image: 'tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const creating = ctx.buildClient(made.secret).imps.create({ name: 'dev-a', image: 'agent' });

  expect(creating).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
