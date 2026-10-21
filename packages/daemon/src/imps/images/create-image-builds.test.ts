import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { createStubDockerCli } from '../../../testing/imps/create-stub-docker-cli';
import { createStubImageMkfs } from '../../../testing/imps/create-stub-image-mkfs';
import { createTreeTar } from '../../../testing/imps/create-tree-tar';
import { spawnSparseFilesTar } from '../../../testing/imps/spawn-sparse-files-tar';
import { buildQueryGate } from '../../../testing/platform/build-query-gate';
import { startDiskSampler } from '../../../testing/vm/start-disk-sampler';
import { loadConfig } from '../../config';
import { createImage, listImages, readImageByName } from '../../platform/db/images';
import { createImp } from '../../platform/db/imps';
import { openDatabase } from '../../platform/db/open-database';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createDiskBudget } from '../../vm/storage/disk-budget';
import { createStorageGate } from '../../vm/storage/storage-gate';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { DOCKERFILE_FRONTEND } from '../docker-proxy/dockerfile-frontend';
import { checkBuildQuery } from '../docker-proxy/rules';
import { normalizeDockerfilePath } from './create-image-builds';
import { createImageService } from './image-service';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'image-builds-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const dataDir = join(directory, 'data');

  await mkdir(dataDir);

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  const docker = createStubDockerCli({ directory });

  updateEnv('PATH', docker.path);

  const usage = { usedBytes: 0, availableBytes: 1024 ** 5 };

  const diskBudget = createDiskBudget({
    storage: { readUsage: () => Promise.resolve(usage) },
    reserveBytes: 0,
    log: () => {},
  });

  const grows: number[] = [];

  const recordedBudget = {
    withRoom: diskBudget.withRoom,
    withGrowingRoom: <T>(
      task: (grow: (totalBytes: number, writtenBytes: number) => Promise<void>) => Promise<T>,
    ) =>
      diskBudget.withGrowingRoom((grow) =>
        task(async (totalBytes, writtenBytes) => {
          grows.push(totalBytes);

          await grow(totalBytes, writtenBytes);
        }),
      ),
  };

  return {
    stack,
    directoryPath: directory,
    dataDir,
    db,
    docker,
    storage: createXfsBackend({ dataDir }),
    usage,
    diskBudget,
    recordedBudget,
    grows,
  };
}

test.each([
  [undefined, 'Dockerfile'],
  ['./Dockerfile', 'Dockerfile'],
  ['sub//./web.Dockerfile', 'sub/web.Dockerfile'],
  ['a/../Dockerfile', 'Dockerfile'],
])('#normalizeDockerfilePath writes %p as %p, a path the proxy lets through', (given, expected) => {
  const path = normalizeDockerfilePath(given);

  const query = new Map([
    ['t', ['imp/x:latest']],
    ['version', ['2']],
    ['buildargs', [JSON.stringify({ BUILDKIT_SYNTAX: DOCKERFILE_FRONTEND })]],
    ['dockerfile', [path]],
  ]);

  expect(path).toBe(expected);
  expect(checkBuildQuery(query)).toStrictEqual({ isOk: true });
});

test.each(['../Dockerfile', 'a/../../Dockerfile', '/etc/passwd', '.', 'sub/'])(
  '#normalizeDockerfilePath refuses %p, which leaves the context or names it',
  (path) => {
    expect(() => normalizeDockerfilePath(path)).toThrow('not a file inside the build context');
  },
);

test('it pins, builds and exports in its builder, with no host engine call', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const image = await images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  const saved = await readImageByName(ctx.db, 'web');

  expect(image as unknown).toStrictEqual({
    id: expect.any(String) as unknown,
    name: 'web',
    ref: 'imp/web:latest',
    digest: expect.stringMatching(/^imp-build-[a-f0-9]{64}$/v) as unknown,
    source: 'oci',
    sourceImp: null,
    sizeBytes: expect.any(Number) as unknown,
    createdAt: expect.any(Date) as unknown,
  });

  expect(saved).toStrictEqual(image);
  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();

  expect(builder.builtDockerfiles).toStrictEqual([
    `FROM base.test/a@sha256:${'a'.repeat(64)}\nRUN true\n`,
  ]);

  expect(ctx.docker.readCalls()).toStrictEqual([]);

  expect(builder.guest.runs.map((run) => run.argv.slice(1, 3).join(' '))).toStrictEqual([
    'version --format',
    'image inspect',
    'image inspect',
    'build --progress=plain',
    'image inspect',
    'create imp-build:latest',
    `export ${STUB_BUILDER_CONTAINER}`,
  ]);
});

test('it lists an on-host build with its builder and step while it runs, and sends its output', async () => {
  const ctx = await setupTest();

  const exporting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lines: string[] = [];

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    buildLog: '#4 [2/2] RUN make all\n#4 0.301 cc -o widget main.c\n#4 DONE 0.5s\n',
    onExport: async () => {
      exporting.resolve();

      await release.promise;
    },
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
    now: () => Date.parse('2026-05-06T07:08:09.000Z'),
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await Bun.write(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM base.test/a:1\nRUN make all\n',
  );

  const building = images.runImageBuild(join(ctx.directoryPath, 'context'), 'web', undefined, {
    output: {
      emitLog: (line) => {
        lines.push(line);
      },
      setStep: () => {},
    },
  });

  await exporting.promise;

  const running = images.listBuildRuns();

  release.resolve();

  await building;

  expect(running).toStrictEqual([
    {
      name: 'web',
      source: 'host',
      startedAt: new Date('2026-05-06T07:08:09.000Z'),
      phase: 'unpack',
      step: '[2/2] RUN make all',
      builder: 'imp-build-stubstub',
    },
  ]);

  expect(lines).toStrictEqual([
    '#4 [2/2] RUN make all',
    '#4 0.301 cc -o widget main.c',
    '#4 DONE 0.5s',
  ]);

  expect(images.listBuildRuns()).toStrictEqual([]);
});

test('it holds disk in 256 MiB steps as the export grows, not at the image cap', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
    signal: new AbortController().signal,
  });

  expect(ctx.grows).toStrictEqual([256 * 1024 ** 2]);
});

test('it refuses with DISK_FULL an export that outgrows the free disk', async () => {
  const ctx = await setupTest();

  ctx.usage.availableBytes = 256 * 1024 ** 2;

  const builder = buildStubImageBuilder({
    exported: spawnSparseFilesTar(ctx.directoryPath, { big: 200 * 1024 ** 2 }).stdout,
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  expect(building).rejects.toMatchObject({ code: 'DISK_FULL' });
});

test('it stops the export at the step the free disk refuses', async () => {
  const ctx = await setupTest();

  ctx.usage.availableBytes = 600 * 1024 ** 2;

  const builder = buildStubImageBuilder({
    exported: spawnSparseFilesTar(ctx.directoryPath, { big: 200 * 1024 ** 2 }).stdout,
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'DISK_FULL' });
  expect(ctx.grows).toStrictEqual([256 * 1024 ** 2, 768 * 1024 ** 2]);
  expect(builder.guest.runs.at(-1)?.closed).toBe(true);
});

test('it releases the disk hold once a build succeeds', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
    signal: new AbortController().signal,
  });

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows).toHaveLength(1);
  expect(status.pendingBytes).toBe(0);
});

test('it removes the oldest unused agent images once a build leaves more than the rollback count, and keeps those in use', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const logged: string[] = [];

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '2' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: (message) => {
      logged.push(message);
    },
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), 'agent-2222222\n');

  for (const [name, lastUsedAt] of [
    ['agent-1111111', '2026-08-01T00:00:00Z'],
    ['agent-2222222', '2026-08-02T00:00:00Z'],
    ['agent-3333333', '2026-08-03T00:00:00Z'],
    ['agent-4444444', '2026-08-04T00:00:00Z'],
    ['agent-5555555', '2026-08-05T00:00:00Z'],
  ] as const) {
    const digest = `sha256:${name.slice(-1).repeat(64)}`;

    await createImage(ctx.db, buildMockNewImage({ name, digest, sizeBytes: 1024 ** 3 }));
    await mkdir(buildImagePaths(ctx.dataDir, digest).directory, { recursive: true });
    await writeFile(buildImagePaths(ctx.dataDir, digest).rootfs, '');

    await ctx.db
      .updateTable('images')
      .set({ last_used_at: Date.parse(lastUsedAt) })
      .where('name', '=', name)
      .execute();
  }

  const used = await readImageByName(ctx.db, 'agent-1111111');

  invariant(used);

  await createImp(ctx.db, buildMockNewImp({ imageId: used.id }));

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'agent-6666666',
    undefined,
    { signal: new AbortController().signal },
  );

  const kept = await listImages(ctx.db);

  expect(kept.map((image) => image.name)).toStrictEqual([
    'agent-1111111',
    'agent-2222222',
    'agent-5555555',
    'agent-6666666',
  ]);

  const removedRootfs = buildImagePaths(ctx.dataDir, `sha256:${'3'.repeat(64)}`).rootfs;
  const usedRootfs = buildImagePaths(ctx.dataDir, `sha256:${'1'.repeat(64)}`).rootfs;

  expect(existsSync(removedRootfs)).toBeFalse();
  expect(existsSync(usedRootfs)).toBeTrue();

  expect(logged.filter((line) => line.startsWith('impd: image prune:'))).toStrictEqual([
    'impd: image prune: removed agent-4444444 (1.0 GiB, last used 2026-08-04T00:00:00.000Z)',
    'impd: image prune: removed agent-3333333 (1.0 GiB, last used 2026-08-03T00:00:00.000Z)',
  ]);
});

test('it keeps every agent image after a build while the prune cannot read which images configs outside impd use', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'agent-3333333',
    undefined,
    { signal: new AbortController().signal },
  );

  const kept = await listImages(ctx.db);

  expect(kept.map((image) => image.name)).toStrictEqual([
    'agent-1111111',
    'agent-2222222',
    'agent-3333333',
  ]);
});

test('it keeps an old agent image that a build of the same digest rebuilds', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const first = await images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'agent-1111111',
    undefined,
    { signal: new AbortController().signal },
  );

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-08-01T00:00:00Z') })
    .where('name', '=', 'agent-1111111')
    .execute();

  const rebuilt = await images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'agent-1111111',
    undefined,
    { signal: new AbortController().signal },
  );

  const kept = await listImages(ctx.db);

  expect(rebuilt.digest).toBe(first.digest);
  expect(kept.map((image) => image.name)).toStrictEqual(['agent-1111111', 'agent-2222222']);
});

test('it releases the disk hold when the export is over the file limit', async () => {
  const ctx = await setupTest();

  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`f${String(index)}`, 'x']),
  );

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, many)],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_IMAGE_MAX_FILES: '5' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(
    Error,
    "the built image's filesystem is over 5 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows).toHaveLength(1);
  expect(status.pendingBytes).toBe(0);
});

test('it refuses an export over IMP_BUILD_IMAGE_MAX_FILES', async () => {
  const ctx = await setupTest();

  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`f${String(index)}`, 'x']),
  );

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, many)],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_IMAGE_MAX_FILES: '5' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  expect(building).rejects.toThrowWithMessage(
    Error,
    "the built image's filesystem is over 5 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );
});

test('it releases the disk hold when the free disk refuses the export', async () => {
  const ctx = await setupTest();

  ctx.usage.availableBytes = 256 * 1024 ** 2;

  const builder = buildStubImageBuilder({
    exported: spawnSparseFilesTar(ctx.directoryPath, { big: 200 * 1024 ** 2 }).stdout,
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'DISK_FULL' });

  const status = await ctx.diskBudget.readStatus();

  expect(ctx.grows).toHaveLength(1);
  expect(status.pendingBytes).toBe(0);
});

test('it releases the disk hold when the client goes while the builder holds its export open', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const client = new AbortController();

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: client.signal,
    },
  );

  await waitFor(() => {
    expect(ctx.grows).not.toBeEmpty();
  });

  client.abort(new Error('the client went'));

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'the client went');

  const status = await ctx.diskBudget.readStatus();

  expect(status.pendingBytes).toBe(0);
});

test('it fails the build when the client goes while the builder holds its export open', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const client = new AbortController();

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: client.signal,
    },
  );

  await waitFor(() => {
    expect(ctx.grows).not.toBeEmpty();
  });

  client.abort(new Error('the client went'));

  expect(building).rejects.toThrowWithMessage(Error, 'the client went');
});

test('it leaves no new row and no rootfs when a template takes the name during the build', async () => {
  const ctx = await setupTest();

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await exporting.promise;
  await createImage(ctx.db, buildMockNewImage({ name: 'web', source: 'imp', sourceImp: 'dev' }));

  templated.resolve(null);

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(
    Error,
    'image web is a template; make it again from an imp, or pick another name',
  );

  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(rows.map((row) => [row.name, row.source])).toStrictEqual([['web', 'imp']]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);

  expect(status.pendingBytes).toBe(0);
});

test('it refuses a build whose name a template took during the build', async () => {
  const ctx = await setupTest();

  const exporting = Promise.withResolvers<null>();
  const templated = Promise.withResolvers<null>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: async () => {
      exporting.resolve(null);

      await templated.promise;
    },
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await exporting.promise;
  await createImage(ctx.db, buildMockNewImage({ name: 'web', source: 'imp', sourceImp: 'dev' }));

  templated.resolve(null);

  expect(building).rejects.toThrowWithMessage(
    Error,
    'image web is a template; make it again from an imp, or pick another name',
  );
});

test('it keeps the rootfs another build of the digest is writing when its own row fails', async () => {
  const ctx = await setupTest();

  const mkfs = createStubImageMkfs(ctx.directoryPath);

  updateEnv('PATH', `${mkfs.bin}:${process.env['PATH'] ?? ''}`);

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'web.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await Bun.write(
    join(ctx.directoryPath, 'web2.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const failing = images.buildImageFromContext(
    join(ctx.directoryPath, 'web.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  const kept = images.buildImageFromContext(
    join(ctx.directoryPath, 'web2.tar'),
    'web2',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await mkfs.waitForStart();

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'export' && run.closed)).toHaveLength(
      2,
    );
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web', source: 'imp', sourceImp: 'dev' }));

  mkfs.release();

  expect(failing).rejects.toThrowWithMessage(
    Error,
    'image web is a template; make it again from an imp, or pick another name',
  );

  const image = await kept;

  expect(existsSync(buildImagePaths(ctx.dataDir, image.digest).rootfs)).toBeTrue();
});

test('it keeps the rootfs when an image rm runs while a build of its digest is between rootfs and row', async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('web2');

  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: gate.wrap(ctx.db),
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'web.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await Bun.write(
    join(ctx.directoryPath, 'web2.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const first = await images.buildImageFromContext(
    join(ctx.directoryPath, 'web.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  const second = images.buildImageFromContext(
    join(ctx.directoryPath, 'web2.tar'),
    'web2',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await gate.reached;

  await images.removeImage('web');

  gate.release();

  await second;

  const rows = await listImages(ctx.db);

  expect(rows.map((row) => [row.name, row.digest])).toStrictEqual([['web2', first.digest]]);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBeTrue();
});

test("it removes that rootfs after all when the build's row then fails", async () => {
  const ctx = await setupTest();

  const gate = buildQueryGate('web2');

  ctx.stack.defer(() => {
    gate.release();
  });

  const exports = { count: 0 };

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    onExport: () => {
      exports.count += 1;

      if (exports.count === 2) {
        gate.arm();
      }

      return Promise.resolve();
    },
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: gate.wrap(ctx.db),
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'web.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await Bun.write(
    join(ctx.directoryPath, 'web2.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const first = await images.buildImageFromContext(
    join(ctx.directoryPath, 'web.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  const second = images.buildImageFromContext(
    join(ctx.directoryPath, 'web2.tar'),
    'web2',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await gate.reached;

  await images.removeImage('web');

  const template = buildMockNewImage({ name: 'web2', source: 'imp', sourceImp: 'dev' });

  await createImage(ctx.db, template);

  gate.release();

  expect(second).rejects.toThrow('UNIQUE');

  const rows = await listImages(ctx.db);

  expect(rows.map((row) => [row.name, row.digest])).toStrictEqual([['web2', template.digest]]);
  expect(existsSync(buildImagePaths(ctx.dataDir, first.digest).rootfs)).toBeFalse();
});

test('it removes a rootfs whose write fails after it is published', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,

    storage: {
      ...ctx.storage,
      createImage: async (digest, write) => {
        await ctx.storage.createImage(digest, write);

        throw new Error('the mount failed');
      },
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'the mount failed');

  const rows = await listImages(ctx.db);

  expect(rows).toStrictEqual([]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);
});

test('it returns the error of a rootfs write that fails after it is published', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,

    storage: {
      ...ctx.storage,
      createImage: async (digest, write) => {
        await ctx.storage.createImage(digest, write);

        throw new Error('the mount failed');
      },
    },
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  expect(building).rejects.toThrowWithMessage(Error, 'the mount failed');
});

test('it leaves no row, rootfs or hold when the client goes while mkfs.ext4 runs', async () => {
  const ctx = await setupTest();

  const mkfs = createStubImageMkfs(ctx.directoryPath);

  updateEnv('PATH', `${mkfs.bin}:${process.env['PATH'] ?? ''}`);

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the builder\n' })],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const client = new AbortController();

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: client.signal,
    },
  );

  await mkfs.waitForStart();

  client.abort(new Error('the client went'));
  mkfs.release();

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(Error, 'the client went');

  const rows = await listImages(ctx.db);
  const status = await ctx.diskBudget.readStatus();

  expect(rows).toStrictEqual([]);

  expect(
    readdirSync(join(ctx.dataDir, 'images')).filter((entry) => entry.startsWith('imp-build-')),
  ).toStrictEqual([]);

  expect(status.pendingBytes).toBe(0);
});

test('it ends a stalled export over a limit at once, with its builder and its disk hold', async () => {
  const ctx = await setupTest();

  const many = Object.fromEntries(
    Array.from({ length: 20 }, (_, index) => [`f${String(index)}`, 'x']),
  );

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, many)],
    repoDigest: `sha256:${'a'.repeat(64)}`,
    isExportStalled: true,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_BUILD_IMAGE_MAX_FILES: '5' }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toThrowWithMessage(
    Error,
    "the built image's filesystem is over 5 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );

  const status = await ctx.diskBudget.readStatus();

  expect(builder.readLive()).toBe(0);
  expect(builder.guest.runs.at(-1)?.closed).toBe(true);
  expect(status.pendingBytes).toBe(0);
});

test('it refuses a Dockerfile the input guard refuses', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'a'.repeat(64)}` });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, {
      Dockerfile: 'FROM base.test/a:1\nADD https://example.com/x /x\n',
    }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});

test('it boots no builder for a Dockerfile the input guard refuses', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'a'.repeat(64)}` });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, {
      Dockerfile: 'FROM base.test/a:1\nADD https://example.com/x /x\n',
    }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  expect(builder.readBoots()).toBe(0);
  expect(builder.guest.runs).toStrictEqual([]);
});

test("it changes no host file through a built image's image.json link", async () => {
  const ctx = await setupTest();

  const hostFile = join(ctx.directoryPath, 'host-file');
  const tree = join(ctx.directoryPath, 'linked-tree');

  await writeFile(hostFile, "the host's\n");
  await mkdir(join(tree, 'etc', 'imp'), { recursive: true });

  symlinkSync(hostFile, join(tree, 'etc', 'imp', 'image.json'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  await images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
    signal: new AbortController().signal,
  });

  expect(readFileSync(hostFile, 'utf8')).toBe("the host's\n");
});

test('it refuses an image whose /etc/imp is a link to a host directory', async () => {
  const ctx = await setupTest();

  const hostDir = join(ctx.directoryPath, 'host-dir');
  const tree = join(ctx.directoryPath, 'linked-tree');

  await mkdir(hostDir);
  await mkdir(join(tree, 'etc'), { recursive: true });

  symlinkSync(hostDir, join(tree, 'etc', 'imp'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining("the image's /etc/imp is a symlink") as unknown,
  });
});

test('it writes nothing into the host directory an /etc/imp link names', async () => {
  const ctx = await setupTest();

  const hostDir = join(ctx.directoryPath, 'host-dir');
  const tree = join(ctx.directoryPath, 'linked-tree');

  await mkdir(hostDir);
  await mkdir(join(tree, 'etc'), { recursive: true });

  symlinkSync(hostDir, join(tree, 'etc', 'imp'));

  const builder = buildStubImageBuilder({
    exported: [Bun.spawnSync(['tar', '-C', tree, '-c', '.']).stdout],
    repoDigest: `sha256:${'a'.repeat(64)}`,
  });

  const images = createImageService({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    diskBudget: ctx.recordedBudget,
    readBuilders: () => builder.builders,
    log: () => {},
  });

  await Bun.write(
    join(ctx.directoryPath, 'context.tar'),
    createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
  );

  const building = images.buildImageFromContext(
    join(ctx.directoryPath, 'context.tar'),
    'web',
    undefined,
    {
      signal: new AbortController().signal,
    },
  );

  await building.catch(() => {});

  expect(building).rejects.toMatchObject({
    code: 'BAD_REQUEST',
    message: expect.stringContaining("the image's /etc/imp is a symlink") as unknown,
  });

  expect(existsSync(join(hostDir, 'image.json'))).toBeFalse();
});

// These need the small real filesystem that IMP_TEST_SMALL_FS names, which CI mounts as a
// loop XFS, and skip without it.
test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a one-file image on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      writeFileSync(join(tree, 'hello'), 'from the builder\n');
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for many empty files on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let directoryIndex = 0; directoryIndex < 30; directoryIndex += 1) {
        mkdirSync(join(tree, `d${String(directoryIndex)}`));

        for (let index = 0; index < 1000; index += 1) {
          writeFileSync(join(tree, `d${String(directoryIndex)}`, `f${String(index)}`), '');
        }
      }
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a deep tree on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let chain = 0; chain < 300; chain += 1) {
        mkdirSync(join(tree, `c${String(chain)}`, ...Array.from({ length: 40 }, () => 'd')), {
          recursive: true,
        });
      }
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a sparse file stored in full on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      const file = join(tree, 'sparse');

      writeFileSync(file, 'x'.repeat(1024 ** 2));

      Bun.spawnSync(['truncate', '-s', String(400 * 1024 ** 2), file]);
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for a sparse file in a GNU sparse member on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(
      ctx.directoryPath,
      (tree) => {
        const file = join(tree, 'sparse');

        writeFileSync(file, 'x'.repeat(1024 ** 2));

        Bun.spawnSync(['truncate', '-s', String(400 * 1024 ** 2), file]);
      },
      ['--sparse'],
    );

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it takes no more than its hold for random data on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let index = 0; index < 3200; index += 1) {
        writeFileSync(
          join(tree, `r${String(index)}`),
          crypto.getRandomValues(new Uint8Array(64 * 1024)),
        );
      }
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it holds the rootfs journal on a small filesystem',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let directoryIndex = 0; directoryIndex < 58; directoryIndex += 1) {
        mkdirSync(join(tree, `d${String(directoryIndex)}`));

        for (let index = 0; index < 1000; index += 1) {
          writeFileSync(
            join(tree, `d${String(directoryIndex)}`, `r${String(index)}`),
            crypto.getRandomValues(new Uint8Array(4096)),
          );
        }
      }
    });

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget: {
        withRoom: diskBudget.withRoom,
        withGrowingRoom: (task) =>
          diskBudget.withGrowingRoom((grow) =>
            task(async (totalBytes, writtenBytes) => {
              grows.push(totalBytes);

              await grow(totalBytes, writtenBytes);
            }),
          ),
      },
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    invariant(2 * exported.byteLength > 500 * 1024 ** 2);
    invariant(2 * exported.byteLength < 512 * 1024 ** 2);

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    const hold = grows.at(-1);

    invariant(hold !== undefined);

    expect(trial.outcome).toBe('built');
    expect(trial.settledBytes).toBeLessThanOrEqual(hold);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses a file bigger than the room on a nearly full small filesystem before the reserve',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      Bun.spawnSync(['truncate', '-s', String(500 * 1024 ** 2), join(tree, 'big')]);
    });

    await sampler.fill(300 * 1024 ** 2, 128 * 1024 ** 2);

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget,
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    expect(trial.outcome).toBe('DISK_FULL');
    expect(trial.peakBytes).toBeLessThanOrEqual(300 * 1024 ** 2);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);

test.skipIf(process.env['IMP_TEST_SMALL_FS'] === undefined)(
  'it refuses files bigger than the room on a nearly full small filesystem before the reserve',
  async () => {
    const ctx = await setupTest();

    const mount = process.env['IMP_TEST_SMALL_FS'] ?? '';

    const sampler = await startDiskSampler(mount);
    const dataDir = await mkdtemp(join(mount, 'data-'));

    onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

    const storage = createXfsBackend({ dataDir });

    const diskBudget = createDiskBudget({
      storage,
      reserveBytes: 128 * 1024 ** 2,
      log: () => {},
    });

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let index = 0; index < 400; index += 1) {
        writeFileSync(
          join(tree, `r${String(index)}`),
          crypto.getRandomValues(new Uint8Array(1024 ** 2)),
        );
      }
    });

    await sampler.fill(300 * 1024 ** 2, 128 * 1024 ** 2);

    const chunks = Array.from({ length: Math.ceil(exported.byteLength / 1024 ** 2) }, (_, index) =>
      exported.subarray(index * 1024 ** 2, (index + 1) * 1024 ** 2),
    );

    const builder = buildStubImageBuilder({
      exported: chunks,
      repoDigest: `sha256:${'a'.repeat(64)}`,
    });

    const images = createImageService({
      config: loadConfig({ IMP_DATA_DIR: dataDir }),
      db: ctx.db,
      storage: {
        ...storage,
        createImage: async (digest, write) => {
          await storage.createImage(digest, write);

          sampler.markWritten();
        },
      },
      storageGate: createStorageGate(),
      diskBudget,
      readBuilders: () => builder.builders,
      log: () => {},
    });

    await Bun.write(
      join(ctx.directoryPath, 'context.tar'),
      createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\nRUN true\n' }),
    );

    const trial = await sampler.measure(() =>
      images.buildImageFromContext(join(ctx.directoryPath, 'context.tar'), 'web', undefined, {
        signal: new AbortController().signal,
      }),
    );

    expect(trial.outcome).toBe('DISK_FULL');
    expect(trial.peakBytes).toBeLessThanOrEqual(300 * 1024 ** 2);
    expect(trial.lowestFree).toBeGreaterThanOrEqual(128 * 1024 ** 2);
  },

  120_000,
);
