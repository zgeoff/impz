import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildStubImageBuilder } from '../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { createStubOciFetch } from '../../../testing/imps/create-stub-oci-fetch';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { loadConfig } from '../../config';
import {
  createImage,
  listImageRemovals,
  listImageUses,
  readImageByName,
} from '../../platform/db/images';
import { openDatabase } from '../../platform/db/open-database';
import { runCommand } from '../../platform/process/run-command';
import { runStreamed } from '../../platform/process/run-streamed';
import { countTreeBytes } from '../../vm/storage/count-tree-bytes';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createDiskBudget } from '../../vm/storage/disk-budget';
import { createStorageGate } from '../../vm/storage/storage-gate';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { BUILDER_IMAGE } from './builders/builder-imps';
import { createImageService } from './image-service';
import { startTarProcess } from './rootfs/start-tar-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'image-service-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
    reserveBytes: null,
  });

  return {
    dataDir,
    db,
    storage: createXfsBackend({ dataDir }),
    diskBudget,
  };
}

test.each(['--help', '-v/:/host', 'ubuntu --privileged', ''])(
  '#addImage refuses %p, which docker could read as a flag',
  async (ref) => {
    const ctx = await setupTest();

    const images = createImageService({
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
      runStreamed,
      config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
      db: ctx.db,
      storage: ctx.storage,
      storageGate: createStorageGate(),
      diskBudget: ctx.diskBudget,
      readBuilders: () => null,
    });

    const adding = images.addImage(ref, 'x');

    expect(adding).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: `invalid image reference ${JSON.stringify(ref)}`,
    });
  },
);

test('#runImageBuild refuses a context path that docker could read as a flag', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.runImageBuild('--file=/etc/passwd', 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'build context "--file=/etc/passwd" is not an absolute path',
  });
});

test('#ensureBuilderImage leaves no work directory behind when the export fails', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir });

  const ociFetch = createStubOciFetch({
    directory: ctx.dataDir,
    images: [{ ref: config.build.image, digest: `sha256:${'c'.repeat(64)}` }],
  });

  updateEnv('PATH', ociFetch.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const ensuring = images.ensureBuilderImage();

  await ensuring.catch(() => {});

  expect(ensuring).rejects.toThrow('MANIFEST_UNKNOWN');
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
});

test('#ensureBuilderImage fails with the error of the given export runner and publishes nothing', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir });

  const ociFetch = createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'c'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    runStreamed: () => Promise.reject(new Error('the registry hung up')),
  });

  const failure = await images.ensureBuilderImage().then(
    () => null,
    (error: unknown) => error,
  );

  const builder = await readImageByName(ctx.db, BUILDER_IMAGE);
  const disk = await ctx.diskBudget.readStatus();

  expect(failure).toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.toEndWith(': the registry hung up'),
  });

  expect(builder).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
  expect(disk.pendingBytes).toBe(0);
});

test('#ensureBuilderImage reads the builder config through the given command runner', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir });

  mkdirSync(join(ctx.dataDir, 'images'));

  const run = mock(() =>
    Promise.resolve({ exitCode: 1, stdout: '', stderr: 'oci-fetch: the mirror is offline' }),
  );

  const images = createImageService({
    runCommand: run,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const failure = await images.ensureBuilderImage().then(
    () => null,
    (error: unknown) => error,
  );

  const builder = await readImageByName(ctx.db, BUILDER_IMAGE);

  expect(failure).toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.toEndWith(': oci-fetch: the mirror is offline'),
  });

  expect(run).toHaveBeenCalledExactlyOnceWith(['oci-fetch', 'config', config.build.image], {
    signal: expect.any(AbortSignal) as unknown,
  });

  expect(builder).toBeUndefined();
});

test('#ensureBuilderImage unpacks the export through the given tar starter', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir });

  const ociFetch = createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'c'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'builder\n' }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    runCommand,
    startTar: () => {
      throw new Error('tar is not installed');
    },
    countTreeBytes,
    runStreamed,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const failure = await images.ensureBuilderImage().then(
    () => null,
    (error: unknown) => error,
  );

  const builder = await readImageByName(ctx.db, BUILDER_IMAGE);

  expect(failure).toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.toEndWith(': tar is not installed'),
  });

  expect(builder).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
});

test('#ensureBuilderImage refuses an export over IMP_BUILD_IMAGE_MAX_MIB and publishes nothing', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_IMAGE_MAX_MIB: '1' });

  const ociFetch = createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'c'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { dockerd: 'x'.repeat(2 * 1024 ** 2) }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const failure = await images.ensureBuilderImage().then(
    () => null,
    (error: unknown) => error,
  );

  const builder = await readImageByName(ctx.db, BUILDER_IMAGE);
  const disk = await ctx.diskBudget.readStatus();

  expect(failure).toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.toEndWith(
      ": the built image's filesystem is over 1 MiB (IMP_BUILD_IMAGE_MAX_MIB)",
    ),
  });

  expect(builder).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
  expect(disk.pendingBytes).toBe(0);
});

test('#ensureBuilderImage refuses an export over IMP_BUILD_IMAGE_MAX_FILES and publishes nothing', async () => {
  const ctx = await setupTest();

  const config = loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_IMAGE_MAX_FILES: '2' });

  const ociFetch = createStubOciFetch({
    directory: ctx.dataDir,
    images: [
      {
        ref: config.build.image,
        digest: `sha256:${'c'.repeat(64)}`,
        exportTar: createFilesTar(ctx.dataDir, { one: '1\n', two: '2\n', three: '3\n' }),
      },
    ],
  });

  updateEnv('PATH', ociFetch.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config,
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const failure = await images.ensureBuilderImage().then(
    () => null,
    (error: unknown) => error,
  );

  const builder = await readImageByName(ctx.db, BUILDER_IMAGE);
  const disk = await ctx.diskBudget.readStatus();

  expect(failure).toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: expect.toEndWith(
      ": the built image's filesystem is over 2 files (IMP_BUILD_IMAGE_MAX_FILES)",
    ),
  });

  expect(builder).toBeUndefined();
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
  expect(disk.pendingBytes).toBe(0);
});

test('#addImage answers SERVICE_UNAVAILABLE while the builders are not up', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const adding = images.addImage('busybox:1.37', 'x');

  expect(adding).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'impd is starting; try again',
  });
});

test('#buildImageFromContext answers SERVICE_UNAVAILABLE while the builders are not up', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');
  const tarPath = join(ctx.dataDir, 'context.tar');

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM scratch\n');

  Bun.spawnSync(['tar', '-C', contextDir, '-cf', tarPath, 'Dockerfile']);

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.buildImageFromContext(tarPath, 'web', undefined, {
    signal: new AbortController().signal,
  });

  expect(building).rejects.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
    message: 'impd is starting; try again',
  });
});

test('#addImage refuses the name imp-builder, which is impd’s', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const adding = images.addImage('busybox:latest', BUILDER_IMAGE);

  expect(adding).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
  });
});

test('#buildImageFromContext refuses the name imp-builder, which is impd’s', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.buildImageFromContext('/nowhere.tar', BUILDER_IMAGE, undefined, {
    signal: new AbortController().signal,
  });

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: `the image name ${BUILDER_IMAGE} is impd's, for its image builders; pick another`,
  });
});

test('#runImageBuild refuses a context that is not on the impd host', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.runImageBuild(join(ctx.dataDir, 'no-such-dir'), 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('does not exist on the impd host') as unknown,
  });
});

test('#runImageBuild refuses a context on the impd host with no Dockerfile', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.runImageBuild(ctx.dataDir, 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('there is no Dockerfile') as unknown,
  });
});

test('#runImageBuild refuses a context over IMP_BUILD_CONTEXT_MAX_MIB before it is sent', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(contextDir, 'big'), new Uint8Array(2 * 1024 ** 2));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_CONTEXT_MAX_MIB: '1' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const building = images.runImageBuild(contextDir, 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(
      'over the limit of 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
    ) as unknown,
  });
});

test('#runImageBuild refuses a Dockerfile image that is not an image reference', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');
  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'a'.repeat(64)}` });

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM a..b\n');

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => builder.builders,
  });

  const building = images.runImageBuild(contextDir, 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'FROM "a..b" is not an image reference',
  });
});

test('#runImageBuild answers BAD_REQUEST when the pinned Dockerfile does not parse back', async () => {
  const ctx = await setupTest();

  const contextDir = join(ctx.dataDir, 'context');

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'a'.repeat(64)} AS evil`,
  });

  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM busybox:1\n');

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => builder.builders,
  });

  const building = images.runImageBuild(contextDir, 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'the Dockerfile: impd could not pin the images this Dockerfile names',
  });
});

test('#resolveImage records the lookup as a use of the image', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    clock: { now: () => Date.parse('2030-01-01T00:00:00Z') },
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-0a1b2c3' }));

  await images.resolveImage('web-0a1b2c3');

  const uses = await listImageUses(ctx.db);

  expect(uses[0]?.lastUsedAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
});

test('#addImage evicts an old image under storage pressure, even when the add fails', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      ...ctx.storage,
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: () =>
        Promise.resolve({
          images: new Map([['sha256:1', { freedBytes: 50, isShared: false }]]),
          freeingBytes: 0,
        }),
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  const failure = await images.addImage('--help', 'x').then(
    () => null,
    (error: unknown) => error,
  );

  const uses = await listImageUses(ctx.db);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(uses).toStrictEqual([]);
});

test('#runImageBuild evicts an old image under storage pressure, even when the build fails', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      ...ctx.storage,
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: () =>
        Promise.resolve({
          images: new Map([['sha256:1', { freedBytes: 50, isShared: false }]]),
          freeingBytes: 0,
        }),
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  const failure = await images.runImageBuild('--file=/etc/passwd', 'x').then(
    () => null,
    (error: unknown) => error,
  );

  const uses = await listImageUses(ctx.db);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(uses).toStrictEqual([]);
});

test('#buildImageFromContext evicts an old image under storage pressure, even when the build fails', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      ...ctx.storage,
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: () =>
        Promise.resolve({
          images: new Map([['sha256:1', { freedBytes: 50, isShared: false }]]),
          freeingBytes: 0,
        }),
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  const failure = await images
    .buildImageFromContext('/nowhere.tar', BUILDER_IMAGE, undefined, {
      signal: new AbortController().signal,
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  const uses = await listImageUses(ctx.db);

  expect(failure).toMatchObject({ code: 'BAD_REQUEST' });
  expect(uses).toStrictEqual([]);
});

test('#updateImagePin answers NOT_FOUND for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  expect(images.updateImagePin('missing', true, null)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('#updateImagePin answers NOT_FOUND to a prefix for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  expect(images.updateImagePin('missing', true, 'ghcr.io/acme/')).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

test('#updateImagePin refuses a prefix the pin of an image whose ref does not start with it', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, buildMockNewImage({ name: 'acme-x', ref: 'docker.io/acme/x:1' }));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const refusal = await images.updateImagePin('acme-x', true, 'ghcr.io/acme/').then(
    () => null,
    (error: unknown) => error,
  );

  const stored = await readImageByName(ctx.db, 'acme-x');

  expect(refusal).toMatchObject({
    code: 'FORBIDDEN',
    message: 'image acme-x has a ref that does not start with ghcr.io/acme/',
  });

  expect(stored?.isPinned).toBeFalse();
});

test('#resolveImage keeps an old image that an eviction reaches while the lookup reads it', async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('web-1111111');

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: gate.wrap(ctx.db),
    storage: {
      ...ctx.storage,
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: () =>
        Promise.resolve({
          images: new Map([['sha256:1', { freedBytes: 50, isShared: false }]]),
          freeingBytes: 0,
        }),
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'web-1111111')
    .execute();

  gate.arm();

  const resolving = images.resolveImage('web-1111111');

  await gate.reached;

  await images.runImageEviction();

  gate.release();

  const image = await resolving;
  const uses = await listImageUses(ctx.db);

  expect(image.name).toBe('web-1111111');
  expect(uses.map((use) => use.name)).toStrictEqual(['web-1111111']);
});

test('#runImageEviction logs an eviction that fails as an error, and resolves', async () => {
  const ctx = await setupTest();

  const lines = captureImpdLogs();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      ...ctx.storage,
      readUsage: () => Promise.reject(new Error('the pool is gone')),
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await images.runImageEviction();

  expect(lines).toStrictEqual(['ERROR impd.image image eviction: the pool is gone']);
});

test('#resolveImage answers NOT_FOUND for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const resolving = images.resolveImage('missing');

  expect(resolving).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: 'image missing not found',
  });
});

test('#resolveImage answers NOT_FOUND naming the default image when neither default image exists', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_DEFAULT_IMAGE: 'tools' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const resolving = images.resolveImage();

  expect(resolving).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'image tools not found' });
});

test('#removeImage answers NOT_FOUND for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const removing = images.removeImage('missing');

  expect(removing).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'image missing not found' });
});

test('#removeImage keeps the rootfs while another image uses its digest', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;
  const rootfs = buildImagePaths(ctx.dataDir, digest).rootfs;

  await Bun.write(rootfs, 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'web', digest }));
  await createImage(ctx.db, buildMockNewImage({ name: 'web-copy', digest }));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await images.removeImage('web');

  expect(existsSync(rootfs)).toBeTrue();
});

test('#removeImage removes the rootfs once no image uses its digest', async () => {
  const ctx = await setupTest();

  const digest = `sha256:${'d'.repeat(64)}`;
  const rootfs = buildImagePaths(ctx.dataDir, digest).rootfs;

  await Bun.write(rootfs, 'rootfs');

  await createImage(ctx.db, buildMockNewImage({ name: 'web', digest }));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await images.removeImage('web');

  expect(existsSync(rootfs)).toBeFalse();
});

test('#removeImage keeps a record of the rootfs while its removal fails', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, buildMockNewImage({ name: 'web', digest: 'sha256:1' }));

  // a file where the images directory belongs makes the rootfs removal fail
  writeFileSync(join(ctx.dataDir, 'images'), '');

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const removing = images.removeImage('web');

  expect(removing).rejects.toMatchObject({ code: 'ENOTDIR' });

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual(['sha256:1']);
});

test('#removeImage leaves no record of the rootfs once it is gone', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, buildMockNewImage({ name: 'web', digest: 'sha256:1' }));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  await images.removeImage('web');

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual([]);
});

test('#removeImage keeps a record of the rootfs while a publisher of its digest defers the removal', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, buildMockNewImage({ name: 'web', digest: 'sha256:1' }));

  const images = createImageService({
    runCommand,
    startTar: startTarProcess,
    countTreeBytes,
    runStreamed,
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
  });

  const removals = await images.withImagePublisher('sha256:1', 'web-2222222', async () => {
    await images.removeImage('web');

    return listImageRemovals(ctx.db);
  });

  expect(removals).toStrictEqual(['sha256:1']);
});
