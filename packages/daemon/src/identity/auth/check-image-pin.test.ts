import { expect, onTestFinished, test } from 'bun:test';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { buildMockCaller } from '../../../testing/identity/build-mock-caller';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { startTestImpd } from '../../../testing/start-test-impd';
import {
  createImage,
  readImageByName,
  updateImage,
  updateImagePin,
} from '../../platform/db/images';
import { checkImagePin } from './check-image-pin';

async function setupTest() {
  // first, so a held read lets go before impd stops
  const gate = buildQueryGate('images');

  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { env: readImpEnv(), wrapDatabase: gate.wrap });

  return { gate, db: harness.db, client: harness.client, buildClient: harness.buildClient };
}

test('it lets through a held image whose name and ref the caller covers', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  expect(
    checkImagePin(caller, ['tansy-*'], 'tansy-x', { ref: 'ghcr.io/zgeoff/tansy-x:1' }),
  ).toBeNull();
});

test('it leaves a name within the patterns that impd does not hold to the handler', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  expect(checkImagePin(caller, ['tansy-*'], 'tansy-x', undefined)).toBeNull();
});

test('it refuses a caller with no image ref prefix, as host-wide', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: null });

  expect(
    checkImagePin(caller, ['tansy-*'], 'tansy-x', { ref: 'ghcr.io/zgeoff/tansy-x:1' }),
  ).toStrictEqual({
    message: `token ${caller.name} is limited to some imps; this call is host-wide`,
    reason: null,
  });
});

test('it refuses a call that names no image', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  expect(checkImagePin(caller, ['tansy-*'], null, undefined)).toStrictEqual({
    message: `token ${caller.name} is limited to some imps, so the call must name the image (name)`,
    reason: 'imp_out_of_scope',
  });
});

test('it refuses a name outside the patterns, whatever the held ref', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  expect(
    checkImagePin(caller, ['tansy-*'], 'base', { ref: 'ghcr.io/zgeoff/tansy-x:1' }),
  ).toStrictEqual({
    message: `token ${caller.name} may not pin or unpin image base`,
    reason: 'imp_out_of_scope',
  });
});

test('it refuses a held image whose ref does not start with the prefix', () => {
  const caller = buildMockCaller({ imps: ['tansy-*'], imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  expect(
    checkImagePin(caller, ['tansy-*'], 'tansy-x', { ref: 'docker.io/zgeoff/tansy-x:1' }),
  ).toStrictEqual({
    message: `token ${caller.name} may pin or unpin only images whose ref starts with ghcr.io/zgeoff/tansy-`,
    reason: null,
  });
});

test('it lets a tansy-* token pin tansy-x, whose ref starts with its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`;

  await createImage(ctx.db, buildMockNewImage({ name: 'tansy-x', ref }));

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const pinned = await ctx.buildClient(made.secret).images.pin({ name: 'tansy-x' });

  expect(pinned).toMatchObject({ name: 'tansy-x', ref, pinned: true });
});

test('it lets a tansy-* token unpin tansy-x, whose ref starts with its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`;

  await createImage(ctx.db, buildMockNewImage({ name: 'tansy-x', ref }));

  await ctx.client.images.pin({ name: 'tansy-x' });

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const unpinned = await ctx.buildClient(made.secret).images.unpin({ name: 'tansy-x' });

  expect(unpinned).toMatchObject({ name: 'tansy-x', ref, pinned: false });
});

test.each([['pin'], ['unpin']] as const)(
  'it refuses a tansy-* token the %s of an image outside its patterns',
  async (procedure) => {
    const ctx = await setupTest();

    await createImage(
      ctx.db,
      buildMockNewImage({
        name: 'other-x',
        ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`,
      }),
    );

    const made = await ctx.client.tokens.create({
      name: 'tansy',
      scope: 'manage',
      imps: ['tansy-*'],
      imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
    });

    expect(
      ctx.buildClient(made.secret).images[procedure]({ name: 'other-x' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'token tansy may not pin or unpin image other-x',
      data: { reason: 'imp_out_of_scope' },
    });
  },
);

test('it refuses a tansy-* token the pin of a name outside its patterns that impd does not hold', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'missing' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy may not pin or unpin image missing',
  });
});

test.each([
  ['pin', 'another registry', `docker.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`],
  ['unpin', 'another registry', `docker.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`],
  ['pin', 'another repository', `ghcr.io/zgeoff/other@sha256:${'e'.repeat(64)}`],
  ['pin', 'a template', 'imp:tansy-a'],
] as const)(
  'it refuses a tansy-* token the %s of tansy-x from %s',
  async (procedure, _label, ref) => {
    const ctx = await setupTest();

    await createImage(ctx.db, buildMockNewImage({ name: 'tansy-x', ref }));

    const made = await ctx.client.tokens.create({
      name: 'tansy',
      scope: 'manage',
      imps: ['tansy-*'],
      imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
    });

    expect(
      ctx.buildClient(made.secret).images[procedure]({ name: 'tansy-x' }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message:
        'token tansy may pin or unpin only images whose ref starts with ghcr.io/zgeoff/tansy-',
    });
  },
);

test.each([
  ['pin', false],
  ['unpin', true],
] as const)(
  'it refuses a tansy-* token the %s of tansy-x whose ref moves outside its prefix after the check',
  async (procedure, isPinned) => {
    const ctx = await setupTest();

    const image = await createImage(
      ctx.db,
      buildMockNewImage({
        name: 'tansy-x',
        ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`,
      }),
    );

    await updateImagePin(ctx.db, 'tansy-x', isPinned);

    const made = await ctx.client.tokens.create({
      name: 'tansy',
      scope: 'manage',
      imps: ['tansy-*'],
      imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
    });

    ctx.gate.arm('tansy-x');

    const call = Promise.allSettled([
      ctx.buildClient(made.secret).images[procedure]({ name: 'tansy-x' }),
    ]);

    await ctx.gate.reached;

    await updateImage(ctx.db, image.id, {
      ref: `docker.io/zgeoff/tansy-x@sha256:${'f'.repeat(64)}`,
      digest: `sha256:${'f'.repeat(64)}`,
      sizeBytes: 1,
    });

    ctx.gate.release();

    const [settled] = await call;
    const stored = await readImageByName(ctx.db, 'tansy-x');

    expect(settled).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'FORBIDDEN',
        message: 'image tansy-x has a ref that does not start with ghcr.io/zgeoff/tansy-',
      },
    });

    expect(stored?.isPinned).toBe(isPinned);
  },
);

test('it leaves an image unpinned after it refuses a tansy-* token its pin', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({
      name: 'tansy-x',
      ref: `docker.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`,
    }),
  );

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const refusal = await ctx
    .buildClient(made.secret)
    .images.pin({ name: 'tansy-x' })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const images = await ctx.client.images.list();

  expect(refusal).toMatchObject({ code: 'FORBIDDEN' });
  expect(images).toPartiallyContain({ name: 'tansy-x', pinned: false });
});

test('it refuses a tansy-* token without an image ref prefix the pin of tansy-x', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'tansy-x', ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}` }),
  );

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'tansy-x' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy is limited to some imps; this call is host-wide',
  });
});

test('it refuses a read token with imp patterns the pin of tansy-x, for its scope', async () => {
  const ctx = await setupTest();

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'tansy-x', ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}` }),
  );

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'read',
    imps: ['tansy-*'],
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'tansy-x' })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    data: { reason: 'scope' },
  });
});

test('it tells a tansy-* token that impd holds no tansy-y to pin', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(ctx.buildClient(made.secret).images.pin({ name: 'tansy-y' })).rejects.toMatchObject({
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
