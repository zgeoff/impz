import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '@impz/testing/stand-in/start-test-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  return {
    client: harness.client,
    buildClient: harness.buildClient,
    createTestImage: harness.createTestImage,
  };
}

test('#images.alias returns the image with its aliases', async () => {
  const ctx = await setupTest();
  const created = await ctx.createTestImage('base-1');

  await ctx.client.images.alias({ alias: 'stable', image: 'base-1' });

  const image = await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  expect(image).toStrictEqual({
    id: created.id,
    name: 'base-1',
    ref: created.ref,
    digest: created.digest,
    source: 'oci',
    createdAt: created.createdAt,
    sizeBytes: created.sizeBytes,
    pinned: false,
    aliases: ['agent', 'stable'],
  });
});

test('#images.list returns the aliases of each image', async () => {
  const ctx = await setupTest();
  const first = await ctx.createTestImage('base-1');
  const second = await ctx.createTestImage('base-2');

  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const images = await ctx.client.images.list();

  expect(images).toStrictEqual([
    {
      id: first.id,
      name: 'base-1',
      ref: first.ref,
      digest: first.digest,
      source: 'oci',
      createdAt: first.createdAt,
      sizeBytes: first.sizeBytes,
      pinned: false,
      aliases: ['agent'],
    },
    {
      id: second.id,
      name: 'base-2',
      ref: second.ref,
      digest: second.digest,
      source: 'oci',
      createdAt: second.createdAt,
      sizeBytes: second.sizeBytes,
      pinned: false,
      aliases: [],
    },
  ]);
});

test('#images.pin returns the aliases of the image it pins', async () => {
  const ctx = await setupTest();
  const created = await ctx.createTestImage('base-1');

  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const image = await ctx.client.images.pin({ name: 'base-1' });

  expect(image).toStrictEqual({
    id: created.id,
    name: 'base-1',
    ref: created.ref,
    digest: created.digest,
    source: 'oci',
    createdAt: created.createdAt,
    sizeBytes: created.sizeBytes,
    pinned: true,
    aliases: ['agent'],
  });
});

test('#images.add of a template again returns the aliases of the image it replaces', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.imps.create({ name: 'dev', image: 'base-1' });
  await ctx.client.images.add({ imp: 'dev', name: 'tools' });
  await ctx.client.images.alias({ alias: 'agent', image: 'tools' });

  const image = await ctx.client.images.add({ imp: 'dev', name: 'tools' });

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'tools',
    ref: expect.toBeString(),
    digest: expect.toBeString(),
    source: 'imp',
    createdAt: expect.toBeValidDate(),
    sizeBytes: expect.toBeNumber(),
    pinned: false,
    aliases: ['agent'],
  });
});

test('#images.unalias removes the alias from the list', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });
  await ctx.client.images.unalias({ alias: 'agent' });

  const images = await ctx.client.images.list();

  expect(images.map((image) => image.aliases)).toStrictEqual([[]]);
});

test('#images.delete refuses an aliased image and names the alias, then removes it after unalias', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const refused = ctx.client.images.delete({ name: 'base-1' });

  expect(refused).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'image base-1 is pointed at by alias agent; remove it with image unalias first',
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
