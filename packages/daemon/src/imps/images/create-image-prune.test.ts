import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { loadConfig } from '../../config';
import { createImage, listImageUses } from '../../platform/db/images';
import { createImp } from '../../platform/db/imps';
import { createStorageGate } from '../../vm/storage/storage-gate';
import { createImagePrune } from './create-image-prune';

async function setupTest() {
  const dataDir = await mkdtemp(join(tmpdir(), 'image-prune-'));

  onTestFinished(() => rm(dataDir, { recursive: true, force: true }));

  const database = await createTestDatabase();

  return {
    dataDir,
    db: database.db,
    removeIdleRootfs: mock<(digest: string) => Promise<void>>(() => Promise.resolve()),
    log: mock<(message: string) => void>(() => {}),
  };
}

test('it keeps every image, and says why once, while the keep file is missing', async () => {
  const ctx = await setupTest();

  const prune = createImagePrune({
    config: loadConfig({ IMP_DATA_DIR: ctx.dataDir, IMP_IMAGE_PRUNE_ROLLBACK: '1' }),
    db: ctx.db,
    storageGate: createStorageGate(),
    removeIdleRootfs: ctx.removeIdleRootfs,
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
  expect(ctx.removeIdleRootfs).not.toHaveBeenCalled();

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
    removeIdleRootfs: ctx.removeIdleRootfs,
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
    removeIdleRootfs: ctx.removeIdleRootfs,
    log: ctx.log,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
  });

  await writeFile(join(ctx.dataDir, 'image-keep'), '');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'agent-1111111', digest: 'sha256:1', sizeBytes: 1610 * 1024 ** 2 }),
  );

  await createImage(ctx.db, buildMockNewImage({ name: 'agent-2222222' }));

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
  expect(ctx.removeIdleRootfs.mock.calls).toStrictEqual([['sha256:1']]);

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
    removeIdleRootfs: ctx.removeIdleRootfs,
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
    removeIdleRootfs: ctx.removeIdleRootfs,
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
    removeIdleRootfs: ctx.removeIdleRootfs,
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
