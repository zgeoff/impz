import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { buildStubImageBuilder } from '../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { startBuilderImpd } from '../../../testing/imps/start-builder-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'check-image-add-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(directory, { hello: 'hi' })],
    repoDigest: `sha256:${'e'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(stack, builder, {
    env: readImpEnv(),
    dataDir: join(directory, 'data'),
  });

  return {
    buildClient: harness.buildClient,
    client: harness.client,
  };
}

test('it lets a tansy-* token add tansy-x from a pinned ref under its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`;

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const image: unknown = await ctx.buildClient(made.secret).images.add({ ref, name: 'tansy-x' });

  expect(image).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tansy-x',
    ref,
    digest: expect.toStartWith('imp-build-') as unknown,
    source: 'oci',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    pinned: false,
  });
});

test('it lets a tansy-* token stream the add of tansy-x from a pinned ref under its prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`;

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const stream = await ctx.buildClient(made.secret).images.addStream({ ref, name: 'tansy-x' });
  const events = await Array.fromAsync(stream);

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'tansy-x', ref } });
});

test.each([
  [
    'another name',
    `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`,
    'other-x',
    'token tansy may not add image other-x',
  ],
  [
    'a tag-only ref',
    'ghcr.io/zgeoff/tansy-x:1.2.3',
    'tansy-x',
    'token tansy may add only an image ref pinned by digest, such as ghcr.io/zgeoff/tansy-app@sha256:…',
  ],
  [
    'another registry',
    `docker.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`,
    'tansy-x',
    'token tansy may add only images whose ref starts with ghcr.io/zgeoff/tansy-',
  ],
  [
    'another repository on the same registry',
    `ghcr.io/zgeoff/other@sha256:${'e'.repeat(64)}`,
    'tansy-x',
    'token tansy may add only images whose ref starts with ghcr.io/zgeoff/tansy-',
  ],
])('it refuses a tansy-* token an add with %s', async (_label, ref, name, message) => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(ctx.buildClient(made.secret).images.add({ ref, name })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message,
  });
});

test('it refuses a tansy-* token a streamed add with a tag-only ref', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const added = ctx
    .buildClient(made.secret)
    .images.addStream({ ref: 'ghcr.io/zgeoff/tansy-x:1.2.3', name: 'tansy-x' });

  expect(added).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a tansy-* token an add that leaves the name to impd', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}` });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy is limited to some imps, so the call must name the image (name)',
    data: { reason: 'imp_out_of_scope' },
  });
});

test('it refuses a tansy-* token a template of its own imp', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(
    ctx.buildClient(made.secret).images.add({ imp: 'tansy-a', name: 'tansy-tpl' }),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy may add only an image from a ref, not a template',
  });
});

test('it refuses a tansy-* token a template input that also holds a ref under its prefix', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const added = ctx.buildClient(made.secret).images.add({
    imp: 'victim',
    ref: `ghcr.io/zgeoff/tansy-@@sha256:${'e'.repeat(64)}`,
    name: 'tansy-x',
  });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy may add only an image from a ref, not a template',
  });
});

test('it refuses a tansy-* token without an image ref prefix any add', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
  });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`, name: 'tansy-x' });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy is limited to some imps; this call is host-wide',
  });
});

test('it shows a token’s image ref prefix in the token list', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const tokens = await ctx.client.tokens.list();

  expect(tokens.map((token) => [token.name, token.imageRefPrefix])).toStrictEqual([
    ['tansy', 'ghcr.io/zgeoff/tansy-'],
  ]);
});

test('it tells a token with an image ref prefix who it is', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const identity = await ctx.buildClient(made.secret).tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    grantable: [],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });
});

test('it gives a token an image ref prefix with an update and keeps its grantable list', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-498-0' });

  await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    grantable: ['gh'],
  });

  const updated = await ctx.client.tokens.update({
    name: 'tansy',
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(updated).toStrictEqual({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    sshKeys: [],
    grantable: ['gh'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
    createdAt: expect.toBeValidDate(),
  });
});

test('it lets a token add an image once an update gives it a prefix', async () => {
  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`;

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
  });

  await ctx.client.tokens.update({ name: 'tansy', imageRefPrefix: 'ghcr.io/zgeoff/tansy-' });

  const image = await ctx.buildClient(made.secret).images.add({ ref, name: 'tansy-x' });

  expect(image.name).toBe('tansy-x');
});

test('it refuses a token an add once an update takes its prefix away', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  await ctx.client.tokens.update({ name: 'tansy', imageRefPrefix: null });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/tansy-x@sha256:${'e'.repeat(64)}`, name: 'tansy-x' });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token tansy is limited to some imps; this call is host-wide',
  });
});

test.each([
  ['a host-wide token', 'manage', undefined],
  ['a token below manage', 'exec', ['tansy-*']],
] as const)('it refuses an image ref prefix for %s', async (_label, scope, imps) => {
  const ctx = await setupTest();

  const created = ctx.client.tokens.create({
    name: 'tansy',
    scope,
    ...(imps !== undefined && { imps: [...imps] }),
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(created).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a token that may add images needs scope manage and imp patterns',
  });
});

test('it refuses an update that gives a host-wide token an image ref prefix', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({ name: 'ops', scope: 'manage' });

  const updated = ctx.client.tokens.update({ name: 'ops', imageRefPrefix: 'ghcr.io/zgeoff/' });

  expect(updated).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'a token that may add images needs scope manage and imp patterns',
  });
});

test('it refuses a token limited to some imps an update of its own image ref prefix', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  const updated = ctx
    .buildClient(made.secret)
    .tokens.update({ name: 'tansy', imageRefPrefix: 'ghcr.io/zgeoff/' });

  expect(updated).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
