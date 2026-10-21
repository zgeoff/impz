import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { createImpClient } from '@impz/client';
import { createImage } from '@impz/daemon/src/platform/db/images';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImpdReleaseFetch,
  startTestImpd,
} from '@impz/daemon/testing';
import { checkDockerBuildx } from '../test-utils/run-docker-build';
import { runImageAdd, runOnHostBuild } from './run-image-op';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const rootToken = faker.string.alphanumeric(32);

  const harness = await startTestImpd(stack, {
    rootToken,

    // the stub VMM boots no builder, so a build runs on this machine's docker
    env: { IMP_BUILD_ISOLATION: 'host' },

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

test.skipIf(!checkDockerBuildx())(
  '#runOnHostBuild builds an image on the host through the stream of a current impd',
  async () => {
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
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      source: 'oci',
      createdAt: expect.toBeValidDate() as unknown,
      sizeBytes: expect.any(Number) as unknown,
      pinned: false,
    });

    expect(ctx.calls).toStrictEqual(['system/features', 'images/buildStream']);
  },
  120_000,
);

test('#runOnHostBuild passes on a current impd’s refusal of a host build', async () => {
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

test.skipIf(!checkDockerBuildx())(
  '#runOnHostBuild builds through the call that answers at the end on an impd from before imageOpStream',
  async () => {
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
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) as unknown,
      source: 'oci',
      createdAt: expect.toBeValidDate() as unknown,
      sizeBytes: expect.any(Number) as unknown,
      pinned: false,
    });

    expect(older.calls).toStrictEqual(['system/features', 'images/build']);
  },
  120_000,
);

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
