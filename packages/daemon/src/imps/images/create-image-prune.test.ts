import { expect, mock, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { loadConfig } from '../../config';
import { createImage, listImageRemovals, listImageUses } from '../../platform/db/images';
import { createImp } from '../../platform/db/imps';
import { buildImagePaths } from '../../vm/storage/data-layout';
import { createDiskBudget } from '../../vm/storage/disk-budget';
import { createStorageGate } from '../../vm/storage/storage-gate';
import { createXfsBackend } from '../../vm/storage/xfs-backend';
import { createImagePrune } from './create-image-prune';
import { createImageWriter } from './create-image-writer';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'image-prune-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const database = await createTestDatabase();

  const writer = createImageWriter({
    config: loadConfig({ IMP_DATA_DIR: dataDir }),
    db: database.db,
    storage: createXfsBackend({ dataDir }),
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
    writer,
    log: mock<(message: string) => void>(() => {}),
  };
}

test('it keeps every image, and says why once, while the keep file is missing', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await prune.runPrune();
  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['agent-1111111', 'agent-2222222']);

  expect(ctx.log.mock.calls).toStrictEqual([
    [
      expect.toStartWith(
        `impd: image prune: kept every image: ${join(ctx.dataDir, 'image-keep')}: cannot read the names of the images that configs outside impd use: `,
      ),
    ],
  ]);
});

test('it keeps every image while the keep file holds a line that is no image name', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), 'agent 3333333\n');
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['agent-1111111', 'agent-2222222']);

  expect(ctx.log.mock.calls).toStrictEqual([
    [
      `impd: image prune: kept every image: ${join(ctx.dataDir, 'image-keep')}: line 1 holds "agent 3333333", which is no image name`,
    ],
  ]);
});

test('it removes the unused agent images past the rollback count, and logs each', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'agent-1111111', digest: 'sha256:1', sizeBytes: 1610 * 1024 ** 2 }),
  );

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-01T00:00:00Z') })
    .where('name', '=', 'agent-1111111')
    .execute();

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-02T00:00:00Z') })
    .where('name', '=', 'agent-2222222')
    .execute();

  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual(['agent-2222222']);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeFalse();

  expect(ctx.log.mock.calls).toStrictEqual([
    ['impd: image prune: removed agent-1111111 (1.6 GiB, last used 2026-09-01T00:00:00.000Z)'],
  ]);
});

test('it never removes an image an imp uses, a kept name holds, or impd boots by default', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_PRUNE_ROLLBACK: '1',
      IMP_DEFAULT_IMAGE: 'agent-3333333',
    }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '# the cloud target\nagent-2222222\n');

  const used = await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-3333333' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-4444444' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: used.id }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual([
    'agent-1111111',
    'agent-2222222',
    'agent-3333333',
    'agent-4444444',
  ]);
});

test('it records the prune as the last use of each image in use', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), 'agent-2222222\n');

  const used = await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-3333333' }));
  await createImp(ctx.db, buildMockNewImp({ imageId: used.id }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => [use.name, use.lastUsedAt])).toStrictEqual([
    ['agent-1111111', Date.parse('2030-01-01T00:00:00Z')],
    ['agent-2222222', Date.parse('2030-01-01T00:00:00Z')],
    ['agent-3333333', 0],
  ]);
});

test('it prunes only the images whose name starts with IMP_IMAGE_PRUNE_PREFIX', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({
      IMP_DATA_DIR: ctx.dataDir,
      IMP_IMAGE_PRUNE_PREFIX: 'runner-',
      IMP_IMAGE_PRUNE_ROLLBACK: '1',
    }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'runner-1111111' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'runner-2222222' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();
  await prune.runPrune();

  const uses = await listImageUses(ctx.db);

  expect(uses.map((use) => use.name)).toStrictEqual([
    'agent-1111111',
    'agent-2222222',
    'runner-2222222',
  ]);
});

test('it removes at the next prune a rootfs whose removal failed after its row went', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111', digest: 'sha256:1' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

  await ctx.db
    .updateTable('images')
    .set({ last_used_at: Date.parse('2026-09-01T00:00:00Z') })
    .where('name', '=', 'agent-1111111')
    .execute();

  // a file where the images directory belongs makes the rootfs removal fail
  await writeFile(join(ctx.dataDir, 'images'), '');

  await prune.runPrune();

  const failedRemovals = await listImageRemovals(ctx.db);

  const failedLog = ctx.log.mock.calls.map((call) => call[0]);

  await rm(join(ctx.dataDir, 'images'));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await prune.runPrune();

  const removals = await listImageRemovals(ctx.db);
  const uses = await listImageUses(ctx.db);

  expect(failedRemovals).toStrictEqual(['sha256:1']);

  expect(failedLog).toStrictEqual([
    expect.toStartWith('impd: image prune: could not remove agent-1111111: '),
  ]);

  expect(removals).toStrictEqual([]);
  expect(uses.map((use) => use.name)).toStrictEqual(['agent-2222222']);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeFalse();
});

test('it keeps the rootfs of a removed image that a new image row uses again', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleImage: ctx.writer.removeIdleImage,
    removeIdleRootfs: ctx.writer.removeIdleRootfs,
    readKeepFile: (path) => readFile(path, 'utf8'),
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');

  await ctx.db.insertInto('image_removals').values({ digest: 'sha256:1', created_at: 0 }).execute();

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-1111111', digest: 'sha256:1' }));
  await mkdir(buildImagePaths(ctx.dataDir, 'sha256:1').directory, { recursive: true });
  await writeFile(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs, '');

  await prune.runPrune();

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual([]);
  expect(existsSync(buildImagePaths(ctx.dataDir, 'sha256:1').rootfs)).toBeTrue();
});
