import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { buildMockNewImage } from '../../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../../testing/platform/create-test-database';
import { buildStubFiemap } from '../../../../testing/vm/build-stub-fiemap';
import { loadConfig } from '../../../config';
import {
  createImage,
  listImageRemovals,
  listImageUses,
  updateImagePin,
} from '../../../platform/db/images';
import { createImp } from '../../../platform/db/imps';
import { buildImagePaths } from '../../../vm/storage/data-layout';
import { createDiskBudget } from '../../../vm/storage/disk-budget';
import { createStorageGate } from '../../../vm/storage/storage-gate';
import { createXfsBackend } from '../../../vm/storage/xfs-backend';
import { createImageWriter } from '../rootfs/create-image-writer';
import { createImageEviction } from './create-image-eviction';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'image-eviction-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const database = await createTestDatabase();

  const fiemap = buildStubFiemap();
  const storage = createXfsBackend({ dataDir, readFileExtents: fiemap.readFileExtents });

  const writer = createImageWriter({
    config: loadConfig({ IMP_DATA_DIR: dataDir }),
    db: database.db,
    storage,
    storageGate: createStorageGate(),
    diskBudget: createDiskBudget({
      storage: { readUsage: () => Promise.resolve({ usedBytes: 0, availableBytes: 1024 ** 4 }) },
      reserveBytes: null,
      log: () => {},
    }),
    log: () => {},
  });

  return {
    dataDir,
    db: database.db,
    fiemap,
    storage,
    writer,
    log: mock<(message: string) => void>(() => {}),
  };
}

test('it keeps every image while no marks are set', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 99, availableBytes: 1 }),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, [
    { logical: 0, physical: 4096, length: 50, flags: 0 },
  ]);

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['web-1111111']);
});

test('it keeps every image and measures none while usage is below the high mark', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 79, availableBytes: 21 }),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['web-1111111']);
  expect(ctx.fiemap.reads).toStrictEqual([]);
});

test('it removes the least recently used images until usage falls under the low mark, and logs each', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1', sizeBytes: 1610 * 1024 ** 2 }),
  );

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'web-2222222', digest: 'sha256:2', sizeBytes: 1024 ** 3 }),
  );

  await createImage(ctx.db, buildMockNewImage({ name: 'web-3333333', digest: 'sha256:3' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:2').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:2').rootfs, '');
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:3').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:3').rootfs, '');

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, [
    { logical: 0, physical: 4096, length: 20, flags: 0 },
  ]);

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:2').rootfs, [
    { logical: 0, physical: 8192, length: 20, flags: 0 },
  ]);

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:3').rootfs, [
    { logical: 0, physical: 12_288, length: 20, flags: 0 },
  ]);

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-01T00:00:00Z') })
    .where('name', '=', 'web-1111111')
    .execute();

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-02T00:00:00Z') })
    .where('name', '=', 'web-2222222')
    .execute();

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-03T00:00:00Z') })
    .where('name', '=', 'web-3333333')
    .execute();

  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['web-3333333']);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeFalse();
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:2').rootfs)).toBeFalse();

  expect(ctx.log.mock.calls).toStrictEqual([
    ['impd: image eviction: removed web-1111111 (1.6 GiB, last used 2026-09-01T00:00:00.000Z)'],
    ['impd: image eviction: removed web-2222222 (1.0 GiB, last used 2026-09-02T00:00:00.000Z)'],
  ]);
});

test('it counts the bytes a pool still frees in the background as available', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: async (digests) => ({
        ...(await ctx.storage.measureImages(digests)),
        freeingBytes: 30,
      }),
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, [
    { logical: 0, physical: 4096, length: 50, flags: 0 },
  ]);

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['web-1111111']);
});

test('it reads usage again after the measure, once the storage settled earlier removals', async () => {
  const ctx = await setupTest();

  const usages = buildStubAnswerQueue([
    { usedBytes: 90, availableBytes: 10 },
    { usedBytes: 70, availableBytes: 30 },
  ]);

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve(usages.next()),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, [
    { logical: 0, physical: 4096, length: 50, flags: 0 },
  ]);

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['web-1111111']);
  expect(usages.left).toBe(0);
});

test('it runs one more pass for an eviction asked for while a pass runs', async () => {
  const ctx = await setupTest();

  const usages = buildStubAnswerQueue([
    { usedBytes: 70, availableBytes: 30 },
    { usedBytes: 90, availableBytes: 10 },
    { usedBytes: 90, availableBytes: 10 },
  ]);

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve(usages.next()),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  ctx.fiemap.setExtents(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, [
    { logical: 0, physical: 4096, length: 50, flags: 0 },
  ]);

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await Promise.all([eviction.runEviction(), eviction.runEviction()]);

  const uses = await listImageUses(ctx.db);

  expect(uses).toStrictEqual([]);
  expect(usages.left).toBe(0);
});

test('it runs a single pass for evictions asked for one after another', async () => {
  const ctx = await setupTest();

  const usages = buildStubAnswerQueue([
    { usedBytes: 70, availableBytes: 30 },
    { usedBytes: 70, availableBytes: 30 },
  ]);

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve(usages.next()),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await eviction.runEviction();
  await eviction.runEviction();

  expect(usages.left).toBe(0);
});

test('it never removes an image an imp uses, a pinned image, or the image impd boots by default', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_DEFAULT_IMAGE: 'base',
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 99, availableBytes: 1 }),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  const used = await createImage(ctx.db, buildMockNewImage({ name: 'used', digest: 'sha256:1' }));

  await createImage(ctx.db, buildMockNewImage({ name: 'kept', digest: 'sha256:2' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'base', digest: 'sha256:3' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: used.id }));
  await updateImagePin(ctx.db, 'kept', true);
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:2').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:2').rootfs, '');
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:3').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:3').rootfs, '');

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['base', 'kept', 'used']);
});

test('it records the eviction as the last use of each image an imp uses', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 10, availableBytes: 90 }),
      measureImages: ctx.storage.measureImages,
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  const used = await createImage(ctx.db, buildMockNewImage({ name: 'used' }));

  await createImage(ctx.db, buildMockNewImage({ name: 'idle' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: used.id }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await eviction.runEviction();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => [use.name, use.lastUsedAt])).toStrictEqual([
    ['idle', 0],
    ['used', Date.parse('2030-01-01T00:00:00Z')],
  ]);
});

test('it removes at the next run a rootfs whose removal failed after its row went', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_EVICT_HIGH_PERCENT: '80',
      IMP_IMAGE_EVICT_LOW_PERCENT: '60',
    }),
    db: ctx.db,
    storage: {
      readUsage: () => Promise.resolve({ usedBytes: 90, availableBytes: 10 }),
      measureImages: () =>
        Promise.resolve({
          images: new Map([['sha256:1', { freedBytes: 50, isShared: false }]]),
          freeingBytes: 0,
        }),
    },
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  // a file where the images directory belongs makes the rootfs removal fail
  await writeFile(join(ctx.dataDir, 'images'), '');

  await eviction.runEviction();

  const failedRemovals = await listImageRemovals(ctx.db);

  const failedLog = ctx.log.mock.calls.map((call) => call[0]);

  await rm(join(ctx.dataDir, 'images'));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await eviction.runEviction();

  const removals = await listImageRemovals(ctx.db);
  const uses = await listImageUses(ctx.db);

  expect(failedRemovals).toStrictEqual(['sha256:1']);

  expect(failedLog).toStrictEqual([
    expect.toStartWith('impd: image eviction: could not remove web-1111111: '),
  ]);

  expect(removals).toStrictEqual([]);
  expect(uses).toStrictEqual([]);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeFalse();
});

test('it keeps the rootfs of a removed image that a new image row uses again', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await ctx.db.insertInto('image_removals').values({ digest: 'sha256:1', created_at: 0 }).execute();

  await createImage(ctx.db, buildMockNewImage({ name: 'web-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await eviction.runEviction();

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual([]);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeTrue();
});

test('it keeps the record of a removed rootfs while a publisher of its digest defers the removal', async () => {
  const ctx = await setupTest();

  const eviction = createImageEviction({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storage: ctx.storage,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await ctx.db.insertInto('image_removals').values({ digest: 'sha256:1', created_at: 0 }).execute();

  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  const removals = await ctx.writer.withPublisher('sha256:1', 'web-1111111', async () => {
    await eviction.runEviction();

    return listImageRemovals(ctx.db);
  });

  expect(removals).toStrictEqual(['sha256:1']);
});
