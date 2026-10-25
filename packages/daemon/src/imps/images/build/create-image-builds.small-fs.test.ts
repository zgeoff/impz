import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateEnv } from '@impz/test-utils/update-env';
import invariant from 'tiny-invariant';
import { buildStubImageBuilder } from '../../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../../testing/imps/create-files-tar';
import { createStubDockerCli } from '../../../../testing/imps/create-stub-docker-cli';
import { createTreeTar } from '../../../../testing/imps/create-tree-tar';
import { startDiskSampler } from '../../../../testing/vm/start-disk-sampler';
import { loadConfig } from '../../../config';
import { openDatabase } from '../../../platform/db/open-database';
import { runCommand } from '../../../platform/process/run-command';
import { countTreeBytes } from '../../../vm/storage/count-tree-bytes';
import { createDiskBudget } from '../../../vm/storage/disk-budget';
import { createStorageGate } from '../../../vm/storage/storage-gate';
import { createXfsBackend } from '../../../vm/storage/xfs-backend';
import { createImageService } from '../image-service';
import { startTarProcess } from '../rootfs/start-tar-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'image-builds-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const db = await openDatabase(':memory:');

  stack.defer(() => db.destroy());

  const docker = createStubDockerCli({ directory });

  updateEnv('PATH', docker.path);

  return { directoryPath: directory, db };
}

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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
    });

    const grows: number[] = [];

    const exported = createTreeTar(ctx.directoryPath, (tree) => {
      for (let index = 0; index < 253; index += 1) {
        writeFileSync(
          join(tree, `r${String(index)}`),
          crypto.getRandomValues(new Uint8Array(1024 ** 2)),
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
      runCommand,
      startTar: startTarProcess,
      countTreeBytes,
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
);
