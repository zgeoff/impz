import { expect, onTestFinished, test } from 'bun:test';
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
    dataDir: harness.dataDir,
    client: harness.client,
    buildClient: harness.buildClient,
    createTestImage: async (name: string) => {
      await Bun.write(buildImagePaths(harness.dataDir, `sha256:${name}`).rootfs, 'rootfs');

      return createImage(
        harness.db,
        buildMockNewImage({ name, digest: `sha256:${name}`, sizeBytes: 6 }),
      );
    },
  };
}

test('#images.alias returns the image with its aliases', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'stable', image: 'base-1' });

  const image = await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  expect(image).toMatchObject({ name: 'base-1', aliases: ['agent', 'stable'] });
});

test('#images.list returns the aliases of each image', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.createTestImage('base-2');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const images = await ctx.client.images.list();

  expect(images.map((image) => [image.name, image.aliases])).toStrictEqual([
    ['base-1', ['agent']],
    ['base-2', []],
  ]);
});

test('#images.pin returns the aliases of the image it pins', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const image = await ctx.client.images.pin({ name: 'base-1' });

  expect(image).toMatchObject({ pinned: true, aliases: ['agent'] });
});

test('#images.unalias removes the alias from the list', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });
  await ctx.client.images.unalias({ alias: 'agent' });

  const images = await ctx.client.images.list();

  expect(images.find((image) => image.name === 'base-1')?.aliases).toStrictEqual([]);
});

test('#images.delete refuses an aliased image, and removes it after unalias', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const refused = ctx.client.images.delete({ name: 'base-1' });

  await expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    message: expect.stringContaining('agent'),
  });

  await ctx.client.images.unalias({ alias: 'agent' });

  expect(ctx.client.images.delete({ name: 'base-1' })).resolves.toStrictEqual({});
});

test('#images.alias answers FORBIDDEN to a token limited to some imps', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const aliasing = ctx.buildClient(made.secret).images.alias({ alias: 'agent', image: 'base-1' });

  expect(aliasing).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('#images.unalias answers FORBIDDEN to a token limited to some imps', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const unaliasing = ctx.buildClient(made.secret).images.unalias({ alias: 'agent' });

  expect(unaliasing).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('#images.alias answers CONFLICT for the name of an image', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.createTestImage('base-2');

  expect(ctx.client.images.alias({ alias: 'base-2', image: 'base-1' })).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});

test('#images.alias answers NOT_FOUND for an image that does not exist', async () => {
  const ctx = await setupTest();

  expect(ctx.client.images.alias({ alias: 'agent', image: 'missing' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('#images.unalias answers NOT_FOUND for an alias that does not exist', async () => {
  const ctx = await setupTest();

  expect(ctx.client.images.unalias({ alias: 'agent' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('#images.add of a template refuses a name an alias holds', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });
  await ctx.client.imps.create({ name: 'dev', image: 'base-1' });

  const adding = ctx.client.images.add({ imp: 'dev', name: 'agent' });

  expect(adding).rejects.toMatchObject({ code: 'CONFLICT' });
});
