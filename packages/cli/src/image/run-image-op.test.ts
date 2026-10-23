import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImageBuilder,
  buildStubImpdReleaseFetch,
  createFilesTar,
  createImage,
  startBuilderImpd,
} from '@impz/daemon/testing';
import { runImageAdd, runOnHostBuild } from './run-image-op';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'cli-image-op-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const rootToken = faker.string.alphanumeric(32);

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(directory, { hello: 'hi' })],
    repoDigest: `sha256:${'e'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(stack, builder, {
    rootToken,
    dataDir: join(directory, 'data'),

    // a template copies the imp's disk, which must stay sparse
    cloneDisk: async (source, target) => {
      await Bun.spawn(['cp', '--sparse=always', source, target]).exited;
    },
  });

  const sendRequest = (request: Request) => harness.impd.api.app.handle(request);
  const calls: string[] = [];

  const sendClientRequest = (request: Request) => {
    calls.push(new URL(request.url).pathname.slice('/rpc/'.length));

    return sendRequest(request);
  };

  const client = createImpClient({
    url: 'http://impd.test',
    token: rootToken,
    fetch: sendClientRequest,
  });

  return { rootToken, dataDir: harness.dataDir, db: harness.db, client, sendRequest, calls };
}

test('#runImageAdd makes a template from an imp through the stream of a current impd', async () => {
  const ctx = await setupTest();

  const base = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, base.digest).rootfs, 'rootfs');

  await createImage(ctx.db, base);

  await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const image = await runImageAdd(ctx.client, { imp: 'box', name: 'tpl' }, 'impz template create', {
    isTTY: false,
    write: () => {},
  });

  const received: unknown = image;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tpl',
    ref: 'imp:box',
    digest: expect.stringMatching(/^imp-/u) as unknown,
    source: 'imp',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    pinned: false,
  });

  expect(ctx.calls).toStrictEqual(['imps/create', 'system/features', 'images/addStream']);
});

test('#runOnHostBuild builds an image from a directory on the impd host through the stream of a current impd', async () => {
  const ctx = await setupTest();
  const contextDir = await mkdtemp(join(tmpdir(), 'cli-image-op-ctx-'));

  onTestFinished(() => rm(contextDir, { recursive: true, force: true }));

  await Bun.write(join(contextDir, 'Dockerfile'), 'FROM scratch\nCOPY hello /hello\n');
  await Bun.write(join(contextDir, 'hello'), 'hi');

  const built = await runOnHostBuild(
    ctx.client,
    { contextDir, name: 'img' },
    { isTTY: false, write: () => {} },
  );

  const received: unknown = built;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'img',
    ref: 'imp/img:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u) as unknown,
    source: 'oci',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    pinned: false,
  });

  expect(ctx.calls).toStrictEqual(['system/features', 'images/buildStream']);
});

test('#runOnHostBuild passes on a current impd’s refusal of a context directory the impd host lacks', async () => {
  const ctx = await setupTest();

  const building = runOnHostBuild(
    ctx.client,
    { contextDir: '/nonexistent/ctx', name: 'img' },
    { isTTY: false, write: () => {} },
  );

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(
      'build context /nonexistent/ctx does not exist on the impd host',
    ) as unknown,
  });
});

test('#runImageAdd adds through the call that answers at the end on an impd from before imageOpStream', async () => {
  const ctx = await setupTest();

  const base = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, base.digest).rootfs, 'rootfs');

  await createImage(ctx.db, base);

  await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const older = buildStubImpdReleaseFetch(ctx.sendRequest, { withoutFeatures: ['imageOpStream'] });

  const added = await runImageAdd(
    createImpClient({ url: 'http://impd.test', token: ctx.rootToken, fetch: older.fetch }),
    { imp: 'box', name: 'tpl' },
    'impz template create',
    { isTTY: false, write: () => {} },
  );

  const received: unknown = added;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'tpl',
    ref: 'imp:box',
    digest: expect.stringMatching(/^imp-/u) as unknown,
    source: 'imp',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    pinned: false,
  });

  expect(older.calls).toStrictEqual(['system/features', 'images/add']);
});

test('#runOnHostBuild builds through the call that answers at the end on an impd from before imageOpStream', async () => {
  const ctx = await setupTest();
  const contextDir = await mkdtemp(join(tmpdir(), 'cli-image-op-ctx-'));

  onTestFinished(() => rm(contextDir, { recursive: true, force: true }));

  await Bun.write(join(contextDir, 'Dockerfile'), 'FROM scratch\nCOPY hello /hello\n');
  await Bun.write(join(contextDir, 'hello'), 'hi');

  const older = buildStubImpdReleaseFetch(ctx.sendRequest, {
    withoutFeatures: ['imageOpStream'],
  });

  const built = await runOnHostBuild(
    createImpClient({ url: 'http://impd.test', token: ctx.rootToken, fetch: older.fetch }),
    { contextDir, name: 'img' },
    { isTTY: false, write: () => {} },
  );

  const received: unknown = built;

  expect(received).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'img',
    ref: 'imp/img:latest',
    digest: expect.stringMatching(/^imp-build-[0-9a-f]{64}$/u) as unknown,
    source: 'oci',
    createdAt: expect.toBeValidDate() as unknown,
    sizeBytes: expect.any(Number) as unknown,
    pinned: false,
  });

  expect(older.calls).toStrictEqual(['system/features', 'images/build']);
});

test('#runImageAdd rejects when impd faults by ending the stream before it answers the image', async () => {
  const ctx = await setupTest();

  const base = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, base.digest).rootfs, 'rootfs');

  await createImage(ctx.db, base);

  await ctx.client.imps.create({ name: 'box', image: 'ubuntu' });

  const faulty = buildStubImpdReleaseFetch(ctx.sendRequest, {
    withoutEvents: { 'images/addStream': ['image'] },
  });

  const adding = runImageAdd(
    createImpClient({ url: 'http://impd.test', token: ctx.rootToken, fetch: faulty.fetch }),
    { imp: 'box', name: 'tpl' },
    'impz template create',
    { isTTY: false, write: () => {} },
  );

  expect(adding).rejects.toThrowWithMessage(
    Error,
    'impd ended the stream before it answered the image',
  );
});
