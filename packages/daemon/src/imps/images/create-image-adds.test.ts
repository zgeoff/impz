import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildStubImageBuilder } from '../../../testing/imps/build-stub-image-builder';
import { createBuilderImage } from '../../../testing/imps/create-builder-image';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { createStubDockerCli } from '../../../testing/imps/create-stub-docker-cli';
import { createStubImageMkfs } from '../../../testing/imps/create-stub-image-mkfs';
import { createStubOciFetch } from '../../../testing/imps/create-stub-oci-fetch';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { startTestImpd } from '../../../testing/start-test-impd';
import type { StubAnswer } from '../../../testing/vm/build-stub-guest';
import { loadConfig } from '../../config';
import { createImage, listImages, readImageByName } from '../../platform/db/images';
import { listImps } from '../../platform/db/imps';
import { runChecked } from '../../platform/process/run-command';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { BUILDER_IMAGE, createBuilders } from './builders/builder-imps';
import { createImageService } from './image-service';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'image-adds-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const docker = createStubDockerCli({ directory: dataDir });
  const ociFetch = createStubOciFetch({ directory: dataDir });

  updateEnv('PATH', docker.path);

  const harness = await startTestImpd(stack, {
    dataDir,

    cloneDisk: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
  });

  return Object.assign(harness, { stack, docker, ociFetch, lines: captureImpdLogs() });
}

test('it adds an image through a builder for one platform, with no host engine call', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const resolved: string[] = [];

  const image = await images.addImage('busybox', 'box', {
    onResolved: (reference) => {
      resolved.push(reference);
    },
  });

  const imps = await listImps(ctx.db);

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'box',
    ref: 'busybox',
    digest: expect.stringMatching(/^imp-build-[a-f0-9]{64}$/v),
    receivedDigest: null,
    source: 'oci',
    sourceImp: null,
    sizeBytes: expect.toBeNumber(),
    createdAt: expect.toBeValidDate(),
    isPinned: false,
  });

  expect(resolved).toStrictEqual([`busybox@sha256:${'b'.repeat(64)}`]);
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
  expect(ctx.docker.readCalls()).toStrictEqual([]);
  expect(workDirs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);

  expect(builder.guest.runs.map((run) => run.argv.slice(1).join(' '))).toIncludeAllMembers([
    'pull --quiet --platform linux/amd64 busybox:latest',
    'tag busybox:latest imp-build:latest',
  ]);

  expect(ctx.lines).toContainEqual(
    expect.toStartWith(
      `INFO impd.image image add box: busybox:latest for linux/amd64 (busybox@sha256:${'b'.repeat(64)}), digest ${image.digest}; pull=`,
    ),
  );
});

test('it logs the pull and image times of an add on its clock', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir });
  const times = buildStubAnswerQueue([1000, 1300, 1600, 1900]);

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
    clock: { now: times.next },
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const image = await images.addImage('busybox', 'box');

  expect(ctx.lines).toContain(
    `INFO impd.image image add box: busybox:latest for linux/amd64 (busybox@sha256:${'b'.repeat(64)}), digest ${image.digest}; pull=300ms image=600ms`,
  );
});

test('it adds an image through a builder, with no host engine call, under a leftover IMP_BUILD_ISOLATION=host', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
    IMP_BUILD_ISOLATION: 'host',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const image = await images.addImage('busybox', 'box');

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
  expect(ctx.docker.readCalls()).toStrictEqual([]);

  expect(builder.guest.runs.map((run) => run.argv.slice(1).join(' '))).toContain(
    'pull --quiet --platform linux/amd64 busybox:latest',
  );
});

test('it returns a failed pull in the builder as the client error', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({ code: 1, stderr: 'Error response from daemon: manifest unknown' }),
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage('busybox:nope', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'the pull of busybox:nope in the builder failed: Error response from daemon: manifest unknown',
  });
});

test("it returns a registry's refusal of a pull in the builder as the client error", async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({
      code: 1,
      stderr:
        'Error response from daemon: pull access denied for private.test/x, repository does not exist or may require docker login: denied: requested access to the resource is denied',
    }),
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage('private.test/x:1', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('requested access to the resource is denied') as unknown,
  });
});

test('it leaves no builder, row or work directory after a failed pull', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => ({ code: 1, stderr: 'Error response from daemon: manifest unknown' }),
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:nope', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message:
      'the pull of busybox:nope in the builder failed: Error response from daemon: manifest unknown',
  });

  const imps = await listImps(ctx.db);
  const box = await readImageByName(ctx.db, 'box');

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(workDirs).toStrictEqual([]);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it refuses an export over IMP_BUILD_IMAGE_MAX_MIB', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
    IMP_BUILD_IMAGE_MAX_MIB: '1',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { big: 'x'.repeat(2 * 1024 ** 2) })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage('busybox:1.37', 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('IMP_BUILD_IMAGE_MAX_MIB') as unknown,
  });
});

test('it leaves no builder, row or work directory after an export over the limit', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
    IMP_BUILD_IMAGE_MAX_MIB: '1',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { big: 'x'.repeat(2 * 1024 ** 2) })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:1.37', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('IMP_BUILD_IMAGE_MAX_MIB') as unknown,
  });

  const imps = await listImps(ctx.db);
  const box = await readImageByName(ctx.db, 'box');

  const workDirs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('.build-'),
  );

  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(workDirs).toStrictEqual([]);
});

test("it changes no host file through an added image's image.json link", async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const canary = join(ctx.dataDir, 'canary');
  const tree = join(ctx.dataDir, 'linked-tree');

  await writeFile(canary, "the host's\n");
  await mkdir(join(tree, 'etc', 'imp'), { recursive: true });

  symlinkSync(canary, join(tree, 'etc', 'imp', 'image.json'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  await images.addImage('busybox:1.37', 'box');

  const content = await readFile(canary, 'utf8');

  expect(content).toBe("the host's\n");
});

test('it ends the pull in the builder, and the builder, when the client goes', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const pulling = Promise.withResolvers<null>();
  const never = Promise.withResolvers<StubAnswer>();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onPull: () => {
      pulling.resolve(null);

      return never.promise;
    },
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const client = new AbortController();

  const adding = images.addImage('busybox:1.37', 'box', { signal: client.signal });

  await pulling.promise;

  client.abort(new Error('the client went'));

  expect(adding).rejects.toThrowWithMessage(Error, 'the client went');

  const imps = await listImps(ctx.db);
  const box = await readImageByName(ctx.db, 'box');

  expect(builder.guest.runs.find((run) => run.argv[1] === 'pull')?.closed).toBe(true);
  expect(imps).toStrictEqual([]);
  expect(box).toBe(undefined);
});

test.each([
  [
    '203.0.113.5:5000/x:1',
    'image 203.0.113.5:5000/x:1: registry 203.0.113.5:5000 is an IP address',
  ],
  ['localhost:5000/x:1', "image localhost:5000/x:1: registry localhost:5000 is the host's own"],
  ['registry.localhost/x:1', "registry registry.localhost is the host's own"],

  ['[2001:db8::1]:5000/x:1', 'invalid image reference'],
])('it refuses %s before any builder boots', async (ref, problem) => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage(ref, 'box')).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(problem) as unknown,
  });

  const imps = await listImps(ctx.db);

  expect(builder.guest.runs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it fails the add of a builder the governor refuses, with no host engine call', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '32768',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage('busybox:1.37', 'box')).rejects.toThrowWithMessage(
    Error,
    /is larger than the whole RAM budget \(16384 MiB\)/v,
  );

  const box = await readImageByName(ctx.db, 'box');

  expect(builder.guest.runs).toStrictEqual([]);
  expect(box).toBe(undefined);
  expect(ctx.docker.readCalls()).toStrictEqual([]);
});

test('it fails the add with SERVICE_UNAVAILABLE when the registry cannot give the builder image', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  expect(images.addImage('busybox:1.37', 'box')).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.stringContaining(
      `impd cannot add its builder image ${config.build.image}`,
    ) as unknown,
  });
});

test('it asks the registry only for the builder image config when it cannot give it', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:1.37', 'box');

  await adding.catch(() => {});

  expect(adding).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

  const imps = await listImps(ctx.db);

  expect(ctx.ociFetch.readCalls()).toStrictEqual([`config ${config.build.image}`]);
  expect(builder.guest.runs).toStrictEqual([]);
  expect(imps).toStrictEqual([]);
});

test('it adds a bumped IMP_BUILD_IMAGE once, by its digest, and moves the row', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createImage(
    ctx.db,
    buildMockNewImage({ name: BUILDER_IMAGE, ref: 'ghcr.io/zgeoff/imp-base:0.1.0' }),
  );

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'f'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  await images.ensureBuilderImage();
  await images.ensureBuilderImage();

  const row = await readImageByName(ctx.db, BUILDER_IMAGE);

  expect(row?.ref).toStrictEqual(config.build.image);
  expect(row?.digest).toStrictEqual(`sha256:${'f'.repeat(64)}`);

  expect(ctx.ociFetch.readCalls()).toStrictEqual([
    `config ${config.build.image}`,
    `export ${config.build.image}`,
  ]);
});

test('it seeds the default image at first start through a builder', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'f'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  await images.seedDefaultImage();

  const seeded = await readImageByName(ctx.db, 'ubuntu');

  const image = config.build.image;

  expect(seeded?.ref).toBe('ubuntu:24.04');
  expect(ctx.ociFetch.readCalls()).toStrictEqual([`config ${image}`, `export ${image}`]);
});

test('it seeds the default image at the next start once the builder image has landed', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  await images.seedDefaultImage();

  const seeded = await readImageByName(ctx.db, 'ubuntu');

  expect(seeded?.ref).toBe('ubuntu:24.04');
  expect(ctx.ociFetch.readCalls()).toStrictEqual([]);
});

test('it fails a builder image fetch that hangs at its limit, naming IMP_BUILD_IMAGE', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [{ ref: config.build.image, digest: `sha256:${'f'.repeat(64)}`, fetch: 'hang' }],
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const pullLimits: AbortController[] = [];

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
    builderImagePullMs: 300,
    startPullLimit: () => {
      const limit = new AbortController();

      pullLimits.push(limit);

      return limit.signal;
    },
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const image = config.build.image;
  const ensuring = images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.ociFetch.readCalls()).toContain(`config ${image}`);
  });

  for (const limit of pullLimits) {
    limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }

  expect(ensuring).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: `impd cannot add its builder image ${image} (IMP_BUILD_IMAGE) from its registry, so no image add or build can run: the fetch did not finish in 0.3 s`,
  });
});

test('it exports nothing when the config fetch of the builder image hangs', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [{ ref: config.build.image, digest: `sha256:${'f'.repeat(64)}`, fetch: 'hang' }],
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const pullLimits: AbortController[] = [];

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
    builderImagePullMs: 300,
    startPullLimit: () => {
      const limit = new AbortController();

      pullLimits.push(limit);

      return limit.signal;
    },
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const ensuring = images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.ociFetch.readCalls()).toContain(`config ${config.build.image}`);
  });

  for (const limit of pullLimits) {
    limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }

  await ensuring.catch(() => {});

  expect(ensuring).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  expect(ctx.ociFetch.readCalls()).toStrictEqual([`config ${config.build.image}`]);
});

test('it fetches the builder image again on the add after a fetch that failed', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [{ ref: config.build.image, digest: `sha256:${'f'.repeat(64)}`, fetch: 'hang' }],
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const pullLimits: AbortController[] = [];

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
    builderImagePullMs: 300,
    startPullLimit: () => {
      const limit = new AbortController();

      pullLimits.push(limit);

      return limit.signal;
    },
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const failing = images.ensureBuilderImage();

  await waitFor(() => {
    expect(ctx.ociFetch.readCalls()).toContain(`config ${config.build.image}`);
  });

  for (const limit of pullLimits) {
    limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }

  const [first] = await Promise.allSettled([failing]);

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'f'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  await images.ensureBuilderImage();

  const row = await readImageByName(ctx.db, BUILDER_IMAGE);

  const fetches = ctx.ociFetch.readCalls().filter((call) => call.startsWith('config '));

  expect(first).toMatchObject({
    status: 'rejected',
    reason: { code: 'SERVICE_UNAVAILABLE' },
  });

  expect(row?.ref).toStrictEqual(config.build.image);
  expect(fetches).toHaveLength(2);
});

test('it stops the wait of a caller that goes, and the fetch it shared goes on for the others', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'f'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const client = new AbortController();

  const leaving = images.ensureBuilderImage(client.signal);
  const staying = images.ensureBuilderImage();

  client.abort(new Error('the client went'));

  expect(leaving).rejects.toThrowWithMessage(Error, 'the client went');

  await staying;

  const row = await readImageByName(ctx.db, BUILDER_IMAGE);

  const fetches = ctx.ociFetch.readCalls().filter((call) => call.startsWith('config '));

  expect(row?.ref).toStrictEqual(config.build.image);
  expect(fetches).toHaveLength(1);
});

test('it names the error of a step after the fetch that fails past the limit, not the fetch', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'f'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  const mkfs = createStubImageMkfs(ctx.dataDir);
  const builder = buildStubImageBuilder({ exported: [], repoDigest: 'sha256:1' });
  const pullLimits: AbortController[] = [];

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
    builderImagePullMs: 300,
    startPullLimit: () => {
      const limit = new AbortController();

      pullLimits.push(limit);

      return limit.signal;
    },
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const ensuring = images.ensureBuilderImage();

  await mkfs.waitForStart();

  for (const limit of pullLimits) {
    limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
  }

  mkfs.fail('no space left on device');

  expect(ensuring).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.stringMatching(
      /^(?!.*the fetch did not finish).*no space left on device/sv,
    ) as unknown,
  });
});

test('it leaves no row, rootfs, hold or builder when the client leaves an add while mkfs.ext4 runs', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const mkfs = createStubImageMkfs(ctx.dataDir);

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const client = new AbortController();

  const adding = images.addImage('busybox:1.37', 'box', { signal: client.signal });

  await mkfs.waitForStart();

  client.abort(new Error('the client went'));
  mkfs.release();

  expect(adding).rejects.toThrowWithMessage(Error, 'the client went');

  const box = await readImageByName(ctx.db, 'box');
  const status = await ctx.impd.diskBudget.readStatus();
  const imps = await listImps(ctx.db);

  const built = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(box).toBe(undefined);
  expect(built).toStrictEqual([]);
  expect(status.pendingBytes).toBe(0);
  expect(imps).toStrictEqual([]);
});

test('it leaves no new row and no rootfs when a template takes the name during an add', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:1.37', 'box');

  await exporting.promise;
  await createImage(ctx.db, buildMockNewImage({ name: 'box', source: 'imp', sourceImp: 'dev' }));

  templated.resolve(null);

  expect(adding).rejects.toThrowWithMessage(
    Error,
    'image box is a template; make it again from an imp, or pick another name',
  );

  const box = await readImageByName(ctx.db, 'box');
  const status = await ctx.impd.diskBudget.readStatus();

  const built = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(box?.source).toBe('imp');
  expect(built).toStrictEqual([]);
  expect(status.pendingBytes).toBe(0);
});

test("it keeps the other's row and rootfs when an add and a build of one digest run at once and one row fails", async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const mkfs = createStubImageMkfs(ctx.dataDir);

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const images = createImageService({
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:1.37', 'box');
  const context = join(ctx.dataDir, 'context');

  await mkdir(context);
  await writeFile(join(context, 'Dockerfile'), 'FROM busybox:1.37\nRUN true\n');

  await Bun.write(
    `${context}.tar`,
    Bun.spawnSync(['tar', '-C', context, '-c', 'Dockerfile']).stdout,
  );

  const building = images.buildImageFromContext(`${context}.tar`, 'web', undefined, {
    signal: new AbortController().signal,
  });

  await mkfs.waitForStart();

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed)).toHaveLength(
      2,
    );
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'box', source: 'imp', sourceImp: 'dev' }));

  mkfs.release();

  expect(adding).rejects.toThrowWithMessage(
    Error,
    'image box is a template; make it again from an imp, or pick another name',
  );

  const built = await building;
  const status = await ctx.impd.diskBudget.readStatus();

  const rootfs = readdirSync(join(ctx.dataDir, 'images')).filter((entry) =>
    entry.startsWith('imp-build-'),
  );

  expect(built.name).toBe('web');
  expect(rootfs).toStrictEqual([built.digest]);
  expect(status.pendingBytes).toBe(0);
});

test('it keeps the rootfs when an image rm runs while an add of its digest is between rootfs and row', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const gate = buildQueryGate('box');

  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const images = createImageService({
    config,
    db: gate.wrap(ctx.db),
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const first = await images.addImage('busybox:1.37', 'one');

  const adding = images.addImage('busybox:1.37', 'box');

  await gate.reached;

  await images.removeImage('one');

  gate.release();

  await adding;

  const rows = await listImages(ctx.db);

  expect(
    rows.filter((row) => row.name !== BUILDER_IMAGE).map((row) => [row.name, row.digest]),
  ).toStrictEqual([['box', first.digest]]);

  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBe(true);
});

test("it removes that rootfs after all when the add's row then fails", async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const gate = buildQueryGate('box');

  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const images = createImageService({
    config,
    db: gate.wrap(ctx.db),
    storage: ctx.storage,
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const first = await images.addImage('busybox:1.37', 'one');

  const adding = images.addImage('busybox:1.37', 'box');

  await gate.reached;

  await images.removeImage('one');

  const template = buildMockNewImage({ name: 'box', source: 'imp', sourceImp: 'dev' });

  await createImage(ctx.db, template);

  gate.release();

  expect(adding).rejects.toThrow('UNIQUE');

  const rows = await listImages(ctx.db);

  expect(
    rows.filter((row) => row.name !== BUILDER_IMAGE).map((row) => [row.name, row.digest]),
  ).toStrictEqual([['box', template.digest]]);

  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBe(false);
});

test('it logs a cleanup removal that fails, and returns the add its own error', async () => {
  const ctx = await setupTest();

  const config = loadConfig({
    IMP_DATA_DIR: ctx.dataDir,
    IMP_BUILD_MEMORY_MIB: '512',
    IMP_BUILD_DISK_GIB: '4',
  });

  await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: config.build.image });

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.dataDir, { hello: 'pulled\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const images = createImageService({
    config,
    db: ctx.db,

    storage: {
      ...ctx.storage,
      removeImage: () => Promise.reject(new Error('the disk is read-only')),
    },
    storageGate: ctx.impd.storageGate,
    diskBudget: ctx.impd.diskBudget,
    readBuilders: () => builders,
  });

  const builders = createBuilders({
    config,
    db: ctx.db,
    imps: { ...ctx.impd.imps, openBuilderExec: (_name, request) => builder.guest.open(request) },
    ensureImage: (signal) => images.ensureBuilderImage(signal),
  });

  const adding = images.addImage('busybox:1.37', 'box');

  await exporting.promise;
  await createImage(ctx.db, buildMockNewImage({ name: 'box', source: 'imp', sourceImp: 'dev' }));

  templated.resolve(null);

  expect(adding).rejects.toThrowWithMessage(
    Error,
    'image box is a template; make it again from an imp, or pick another name',
  );

  expect(ctx.lines).toContainEqual(
    expect.stringMatching(
      /^WARNING impd\.image image box: could not remove the unused rootfs of imp-build-[a-f0-9]{64}: the disk is read-only$/v,
    ),
  );
});
