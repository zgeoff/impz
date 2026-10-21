import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { createStubDockerCli } from '../../../testing/imps/create-stub-docker-cli';
import { loadConfig } from '../../config';
import { createImage, listImageUses } from '../../platform/db/images';
import { openDatabase } from '../../platform/db/open-database';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createDiskBudget } from '../../vm/storage/disk-budget';
import { createStorageGate } from '../../vm/storage/storage-gate';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { BUILDER_IMAGE } from './builder-imps';
import { createImageService } from './image-service';

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
    log: () => {},
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
      config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
      db: ctx.db,
      storage: ctx.storage,
      storageGate: createStorageGate(),
      diskBudget: ctx.diskBudget,
      readBuilders: () => null,
      log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  const building = images.runImageBuild('--file=/etc/passwd', 'x');

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: 'build context "--file=/etc/passwd" is not an absolute path',
  });
});

test('#addImage answers a proxy refusal of the pull as BAD_REQUEST with its message alone', async () => {
  const ctx = await setupTest();

  const refusal = "imp-docker-proxy: registry localhost:5320 is the host's own";

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: ['registry.example/pulled:1'],
        inspects: [{ Id: `sha256:${'c'.repeat(64)}` }],
        isOnHost: false,
        pull: { stderr: `Error response from daemon: ${refusal}` },
      },
    ],
  });

  updateEnv('PATH', docker.path);

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'host' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  const adding = images.addImage('registry.example/pulled:1', 'x');

  expect(adding).rejects.toMatchObject({ code: 'BAD_REQUEST', message: refusal });
});

test('#addImage answers a proxy refusal of the create as BAD_REQUEST with its message alone', async () => {
  const ctx = await setupTest();

  const refusal = "imp-docker-proxy: registry localhost:5320 is the host's own";

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: ['registry.example/local:1'],
        inspects: [{ Id: `sha256:${'c'.repeat(64)}`, Config: {}, Size: 1 }],
      },
    ],
    create: {
      stderr: `Unable to find image 'localhost:5320/x:1' locally\nError response from daemon: ${refusal}`,
    },
  });

  updateEnv('PATH', docker.path);

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'host' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  const adding = images.addImage('registry.example/local:1', 'x');

  expect(adding).rejects.toMatchObject({ code: 'BAD_REQUEST', message: refusal });
});

test('#addImage leaves no work directory behind when the create fails', async () => {
  const ctx = await setupTest();

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: ['registry.example/local:1'],
        inspects: [{ Id: `sha256:${'c'.repeat(64)}`, Config: {}, Size: 1 }],
      },
    ],
    create: { stderr: 'no space left on device' },
  });

  updateEnv('PATH', docker.path);
  mkdirSync(join(ctx.dataDir, 'images'));

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'host' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  const adding = images.addImage('registry.example/local:1', 'x');

  await adding.catch(() => {});

  expect(adding).rejects.toThrow('no space left on device');
  expect(readdirSync(join(ctx.dataDir, 'images'))).toStrictEqual([]);
});

test('#addImage answers SERVICE_UNAVAILABLE while the builders are not up', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'imp' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'imp' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_CONTEXT_MAX_MIB: '1' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
  const docker = createStubDockerCli({ directory: ctx.dataDir });

  updateEnv('PATH', docker.path);
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM a..b\n');

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'host' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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

  const docker = createStubDockerCli({
    directory: ctx.dataDir,
    images: [
      {
        refs: ['busybox:1'],
        inspects: [
          {
            Id: `sha256:${'c'.repeat(64)}`,
            RepoDigests: [`busybox@sha256:${'a'.repeat(64)} AS evil`],
          },
        ],
      },
    ],
  });

  updateEnv('PATH', docker.path);
  mkdirSync(contextDir);
  writeFileSync(join(contextDir, 'Dockerfile'), 'FROM busybox:1\n');

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_ISOLATION: 'host' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-0a1b2c3' }));

  await images.resolveImage('agent-0a1b2c3');

  const uses = await listImageUses(ctx.db);

  expect(uses[0]?.lastUsedAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
});

test('#resolveImage answers NOT_FOUND for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_DEFAULT_IMAGE: 'tools' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  const resolving = images.resolveImage();

  expect(resolving).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'image tools not found' });
});

test('#removeImage answers NOT_FOUND for a name no image has', async () => {
  const ctx = await setupTest();

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
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
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.diskBudget,
    readBuilders: () => null,
    log: () => {},
  });

  await images.removeImage('web');

  expect(existsSync(rootfs)).toBeFalse();
});
