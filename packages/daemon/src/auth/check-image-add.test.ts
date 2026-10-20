import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readImpEnv } from '@impz/test-utils/read-imp-env';
import { updateEnv } from '@impz/test-utils/update-env';
import { createStubDockerCli } from '../../testing/imps/create-stub-docker-cli';
import { startTestImpd } from '../../testing/start-test-impd';

// A token limited to some imps that adds images under its own names from
// the registry path it was given (docs/guides/tokens.md#adding-images),
// through the API as a client calls it.

// impd's real app on stub VMs, a root client, `buildClient` for a client that
// sends a token's secret, and `tree`, a directory a stub docker exports
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack, { env: readImpEnv() });

  // the files an image's export holds, which a stub docker tars up
  const tree = join(harness.dataDir, 'tree');

  await mkdir(tree);
  await writeFile(join(tree, 'hello'), 'hi');

  return {
    dataDir: harness.dataDir,
    tree,
    buildClient: harness.buildClient,
    client: harness.client,
  };
}

test('it lets a nixie-* token add nixie-x from a pinned ref under its prefix', async () => {
  updateEnv('IMP_BUILD_ISOLATION', 'host');

  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`;

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: [ref],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2, RepoDigests: [ref] }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', ctx.tree, '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const image: unknown = await ctx.buildClient(made.secret).images.add({ ref, name: 'nixie-x' });

  expect(image).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'nixie-x',
    ref,
    digest: expect.toStartWith('sha256:') as unknown,
    source: 'oci',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
  });
});

test('it lets a nixie-* token stream the add of nixie-x from a pinned ref under its prefix', async () => {
  updateEnv('IMP_BUILD_ISOLATION', 'host');

  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`;

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: [ref],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2, RepoDigests: [ref] }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', ctx.tree, '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const stream = await ctx.buildClient(made.secret).images.addStream({ ref, name: 'nixie-x' });
  const events = await Array.fromAsync(stream);

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'nixie-x', ref } });
});

// each refused before impd pulls anything, so no stub docker is on the PATH
test.each([
  [
    'another name',
    `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`,
    'other-x',
    'token nixie may not add image other-x',
  ],
  [
    'a tag-only ref',
    'ghcr.io/zgeoff/nixie-x:1.2.3',
    'nixie-x',
    'token nixie may add only an image ref pinned by digest, such as ghcr.io/zgeoff/nixie-app@sha256:…',
  ],
  [
    'another registry',
    `docker.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`,
    'nixie-x',
    'token nixie may add only images whose ref starts with ghcr.io/zgeoff/nixie-',
  ],
  [
    'another repository on the same registry',
    `ghcr.io/zgeoff/other@sha256:${'e'.repeat(64)}`,
    'nixie-x',
    'token nixie may add only images whose ref starts with ghcr.io/zgeoff/nixie-',
  ],
])('it refuses a nixie-* token an add with %s', async (_label, ref, name, message) => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  expect(ctx.buildClient(made.secret).images.add({ ref, name })).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message,
  });
});

test('it refuses a nixie-* token a streamed add with a tag-only ref', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const added = ctx
    .buildClient(made.secret)
    .images.addStream({ ref: 'ghcr.io/zgeoff/nixie-x:1.2.3', name: 'nixie-x' });

  expect(added).rejects.toMatchObject({ code: 'FORBIDDEN' });
});

test('it refuses a nixie-* token an add that leaves the name to impd', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}` });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie is limited to some imps, so the call must name the image (name)',
    data: { reason: 'imp_out_of_scope' },
  });
});

test('it refuses a nixie-* token a template of its own imp', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  expect(
    ctx.buildClient(made.secret).images.add({ imp: 'nixie-a', name: 'nixie-tpl' }),
  ).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie may add only an image from a ref, not a template',
  });
});

test('it refuses a nixie-* token a template input that also holds a ref under its prefix', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  // the ref fails its schema, so without the check the input would parse as
  // a template copy of the imp it names
  const added = ctx.buildClient(made.secret).images.add({
    imp: 'victim',
    ref: `ghcr.io/zgeoff/nixie-@@sha256:${'e'.repeat(64)}`,
    name: 'nixie-x',
  });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie may add only an image from a ref, not a template',
  });
});

test('it refuses a nixie-* token without an image ref prefix any add', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
  });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`, name: 'nixie-x' });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie is limited to some imps; this call is host-wide',
  });
});

test('it shows a token’s image ref prefix in the token list', async () => {
  const ctx = await setupTest();

  await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const tokens = await ctx.client.tokens.list();

  expect(tokens.map((token) => [token.name, token.imageRefPrefix])).toStrictEqual([
    ['nixie', 'ghcr.io/zgeoff/nixie-'],
  ]);
});

test('it tells a token with an image ref prefix who it is', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const identity = await ctx.buildClient(made.secret).tokens.whoami();

  expect(identity).toStrictEqual({
    kind: 'token',
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    grantable: [],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });
});

test('it gives a token an image ref prefix with an update and keeps its grantable list', async () => {
  const ctx = await setupTest();

  await ctx.client.secrets.add({ name: 'gh', kind: 'github', value: 'sk-synthetic-498-0' });

  await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    grantable: ['gh'],
  });

  const updated = await ctx.client.tokens.update({
    name: 'nixie',
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  expect(updated).toStrictEqual({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    sshKeys: [],
    grantable: ['gh'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
    createdAt: expect.toBeValidDate(),
  });
});

test('it lets a token add an image once an update gives it a prefix', async () => {
  updateEnv('IMP_BUILD_ISOLATION', 'host');

  const ctx = await setupTest();

  const ref = `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`;

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: [ref],
        inspects: [{ Id: `sha256:${'b'.repeat(64)}`, Config: {}, Size: 2, RepoDigests: [ref] }],
        isOnHost: false,
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', ctx.tree, '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
  });

  await ctx.client.tokens.update({ name: 'nixie', imageRefPrefix: 'ghcr.io/zgeoff/nixie-' });

  const image = await ctx.buildClient(made.secret).images.add({ ref, name: 'nixie-x' });

  expect(image.name).toBe('nixie-x');
});

test('it refuses a token an add once an update takes its prefix away', async () => {
  const ctx = await setupTest();

  const made = await ctx.client.tokens.create({
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  await ctx.client.tokens.update({ name: 'nixie', imageRefPrefix: null });

  const added = ctx
    .buildClient(made.secret)
    .images.add({ ref: `ghcr.io/zgeoff/nixie-x@sha256:${'e'.repeat(64)}`, name: 'nixie-x' });

  expect(added).rejects.toMatchObject({
    code: 'FORBIDDEN',
    message: 'token nixie is limited to some imps; this call is host-wide',
  });
});

test.each([
  ['a host-wide token', 'manage', undefined],
  ['a token below manage', 'exec', ['nixie-*']],
] as const)('it refuses an image ref prefix for %s', async (_label, scope, imps) => {
  const ctx = await setupTest();

  const created = ctx.client.tokens.create({
    name: 'nixie',
    scope,
    ...(imps !== undefined && { imps: [...imps] }),
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
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
    name: 'nixie',
    scope: 'manage',
    imps: ['nixie-*'],
    imageRefPrefix: 'ghcr.io/zgeoff/nixie-',
  });

  const updated = ctx
    .buildClient(made.secret)
    .tokens.update({ name: 'nixie', imageRefPrefix: 'ghcr.io/zgeoff/' });

  expect(updated).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
