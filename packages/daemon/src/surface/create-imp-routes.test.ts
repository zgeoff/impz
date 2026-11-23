import { expect, onTestFinished, test } from 'bun:test';
import { startTestImpd } from '@impz/testing/stand-in/start-test-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const gate = {
    isArmed: false,
    reached: Promise.withResolvers<void>(),
    released: Promise.withResolvers<void>(),
  };

  onTestFinished(() => {
    gate.released.resolve();
  });

  // the disk budget reads the usage first in a create, after the route has checked the image
  const harness = await startTestImpd(stack, {
    boundaries: {
      readDiskSpace: async () => {
        if (gate.isArmed) {
          gate.isArmed = false;

          gate.reached.resolve();

          await gate.released.promise;
        }

        return { usedBytes: 0, availableBytes: 1024 ** 4 };
      },
    },
  });

  return {
    client: harness.client,
    buildClient: harness.buildClient,
    holdNextCreate: () => {
      gate.isArmed = true;
    },
    reachedCreate: gate.reached.promise,
    releaseCreate: () => {
      gate.released.resolve();
    },
    createTestImage: harness.createTestImage,
  };
}

test('#imps.create makes an imp from the image an alias points at', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const imp = await ctx.client.imps.create({ name: 'dev', image: 'agent' });

  expect(imp.image).toBe('base-1');
});

test('#imps.create gives an existing imp the image it was made from after the alias moves', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.createTestImage('base-2');
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

  await ctx.createTestImage('base-1');
  await ctx.client.imps.create({ name: 'secret', image: 'base-1' });
  await ctx.client.images.add({ imp: 'secret', name: 'tpl' });
  await ctx.client.images.alias({ alias: 'agent', image: 'base-1' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  ctx.holdNextCreate();

  const creating = ctx.buildClient(made.secret).imps.create({ name: 'dev-a', image: 'agent' });

  await ctx.reachedCreate;

  // the alias moves to a template the token may not copy, after the route has checked its image
  await ctx.client.images.alias({ alias: 'agent', image: 'tpl' });

  ctx.releaseCreate();

  const imp = await creating;

  expect(imp.image).toBe('base-1');
});

test('#imps.create refuses a scoped caller the template an alias points at', async () => {
  const ctx = await setupTest();

  await ctx.createTestImage('base-1');
  await ctx.client.imps.create({ name: 'secret', image: 'base-1' });
  await ctx.client.images.add({ imp: 'secret', name: 'tpl' });
  await ctx.client.images.alias({ alias: 'agent', image: 'tpl' });

  const made = await ctx.client.tokens.create({ name: 'dev', scope: 'manage', imps: ['dev-*'] });

  const creating = ctx.buildClient(made.secret).imps.create({ name: 'dev-a', image: 'agent' });

  expect(creating).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
