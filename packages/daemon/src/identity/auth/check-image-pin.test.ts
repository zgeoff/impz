import { expect, onTestFinished, test } from 'bun:test';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { startTestImpd } from '../../../testing/start-test-impd';
import { createImage } from '../../platform/db/images';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { env: readImpEnv() });

  return { db: harness.db, client: harness.client, buildClient: harness.buildClient };
}

test('it lets a nixie-* token pin nixie-x, whose ref starts with its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`;

  await createImage(ctx.db, buildMockNewImage({ name: 'nixie-x', ref }));

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const pinned = await ctx.buildClient(made.secret).images.pin({ name: 'nixie-x' });

  expect(pinned).toMatchObject({ name: 'nixie-x', ref, pinned: true });
});

test('it lets a nixie-* token unpin nixie-x, whose ref starts with its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`;

  await createImage(ctx.db, buildMockNewImage({ name: 'nixie-x', ref }));

  await ctx.client.images.pin({ name: 'nixie-x' });

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const unpinned = await ctx.buildClient(made.secret).images.unpin({ name: 'nixie-x' });

  expect(unpinned).toMatchObject({ name: 'nixie-x', ref, pinned: false });
});

test.each([['pin'], ['unpin']] as const)(
  'it refuses a nixie-* token the %s of an image outside its patterns',
  async (procedure) => {
    const ctx = await setupTest();

    await createImage(
      ctx.db,
      buildMockNewImage({
        name: 'other-x',
        ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`,
      }),
    );

    const made = await ctx.client.tokens.create({
      name: 'nixie',
      scope: 'manage',
      imps: ['nixie-*'],
      imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
    });

    expect(
      ctx.buildClient(made.secret).images[procedure]({ name: 'other-x' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'token nixie may not pin or unpin image other-x',
      data: { reason: 'imp_out_of_scope' },
    });
  },
);

test('it refuses a nixie-* token the pin of a name outside its patterns that impd does not hold', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'missing' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie may not pin or unpin image missing',
  });
});

test.each([
  ['pin', 'another registry', `docker.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`],
  ['unpin', 'another registry', `docker.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`],
  ['pin', 'another repository', `ghcr.io/zgeoff/other@sha256:${'e'.repeat(64)}`],
  ['pin', 'a template', 'imp:nixie-a'],
] as const)(
  'it refuses a nixie-* token the %s of nixie-x from %s',
  async (procedure, _label, ref) => {
    const ctx = await setupTest();

    await createImage(ctx.db, buildMockNewImage({ name: 'nixie-x', ref }));

    const made = await ctx.client.tokens.create({
      name: 'nixie',
      scope: 'manage',
      imps: ['nixie-*'],
      imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
    });

    expect(
      ctx.buildClient(made.secret).images[procedure]({ name: 'nixie-x' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'token nixie may pin or unpin only images whose ref starts with ghcr.io/zgeoff/nixie-',
    });
  },
);

test('it leaves an image unpinned after it refuses a nixie-* token its pin', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({
      name: 'nixie-x',
      ref: `docker.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`,
    }),
  );

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const refusal = await ctx
    .buildClient(made.secret)
    .images.pin({ name: 'nixie-x' })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const images = await ctx.client.images.list();

  expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
  expect(images).toPartiallyContain({ name: 'nixie-x', pinned: false });
});

test('it refuses a nixie-* token without an image ref prefix the pin of nixie-x', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'nixie-x', ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}` }),
  );

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'nixie-x' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie is limited to some imps; this call is host-wide',
  });
});

test('it refuses a read token with imp patterns the pin of nixie-x, for its scope', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'nixie-x', ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}` }),
  );

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'read',
    imps: ['nixie-*'],
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'nixie-x' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'scope' },
  });
});

test('it tells a nixie-* token that impd holds no nixie-y to pin', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'nixie-y' })).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('it lets a host-wide manage token pin an image from any registry', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'tools', ref: 'docker.io/library/ubuntu:24.04' }),
  );

  const made = await ctx.client.tokens.create({ name: 'ops', scope: 'manage' });
  const pinned = await ctx.buildClient(made.secret).images.pin({ name: 'tools' });

  expect(pinned).toMatchObject({ name: 'tools', pinned: true });
});

test('it lets a host-wide manage token unpin an image from any registry', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'tools', ref: 'docker.io/library/ubuntu:24.04' }),
  );

  await ctx.client.images.pin({ name: 'tools' });

  const made = await ctx.client.tokens.create({ name: 'ops', scope: 'manage' });
  const unpinned = await ctx.buildClient(made.secret).images.unpin({ name: 'tools' });

  expect(unpinned).toMatchObject({ name: 'tools', pinned: false });
});
