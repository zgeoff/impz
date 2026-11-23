import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startTestImpd } from '@impz/testing/stand-in/start-test-impd';
import { readImageByName } from '../../platform/db/create-image';
import { buildImagePaths } from '../../vm/storage/build-imp-paths';
import { createImageFromFile } from './create-image-from-file';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const harness = await startTestImpd(stack);

  const imported = {
    name: 'web',
    ref: 'imp/web:latest',
    digest: `sha256:${'a'.repeat(64)}`,
    sizeBytes: 6,
    source: 'oci',
    sourceImp: null,
    rootfsPath: '/unused/rootfs.ext4',
    configPath: '/unused/config.json',
  } as const;

  return {
    harness,
    imported,
    importImage: (onWrite: () => Promise<void> = () => Promise.resolve()) =>
      createImageFromFile(
        {
          db: harness.db,
          storage: harness.storage,
          images: harness.images,
          now: () => 1000,
          writeImageFiles: async (_files, directory) => {
            await Bun.write(join(directory, 'rootfs.ext4'), 'rootfs');

            await onWrite();
          },
        },
        imported,
      ),
  };
}

test('it writes the image row and keeps the rootfs of an import', async () => {
  const ctx = await setupTest();
  const name = await ctx.importImage();
  const row = await readImageByName(ctx.harness.db, 'web');

  expect(name).toBe('web');
  expect(row?.digest).toBe(ctx.imported.digest);
  expect(existsSync(buildImagePaths(ctx.harness.dataDir, ctx.imported.digest).rootfs)).toBeTrue();
});

test('it imports under the digest-suffixed name when an alias holds the name', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base-1');
  await ctx.harness.images.updateImageAlias('web', 'base-1');

  const name = await ctx.importImage();

  expect(name).toBe('web-aaaaaaaa');
});

test('it removes the published rootfs and writes no row when an alias takes the name after the name check', async () => {
  const ctx = await setupTest();

  await ctx.harness.createTestImage('base-1');

  const importing = ctx.importImage(async () => {
    await ctx.harness.images.updateImageAlias('web', 'base-1');
  });

  await Promise.allSettled([importing]);

  expect(importing).rejects.toMatchObject({ code: 'CONFLICT' });

  const row = await readImageByName(ctx.harness.db, 'web');

  expect(row).toBeUndefined();
  expect(existsSync(buildImagePaths(ctx.harness.dataDir, ctx.imported.digest).rootfs)).toBeFalse();
});
