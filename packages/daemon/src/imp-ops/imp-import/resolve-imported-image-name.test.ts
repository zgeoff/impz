import { expect, test } from 'bun:test';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import { createImage } from '../../platform/db/images';
import { resolveImportedImageName } from './resolve-imported-image-name';

async function setupTest() {
  const database = await createTestDatabase();

  return { db: database.db };
}

test('it keeps the name of an image this host has no image by', async () => {
  const ctx = await setupTest();
  const name = await resolveImportedImageName(ctx.db, 'web', `sha256:${'a1'.repeat(32)}`);

  expect(name).toBe('web');
});

test('it tags the name with the digest when an image holds the name already', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp/web:1',
    digest: `sha256:${'b2'.repeat(32)}`,
    sizeBytes: 1,
    source: 'oci',
    sourceImp: null,
  });

  const name = await resolveImportedImageName(ctx.db, 'web', `sha256:${'a1'.repeat(32)}`);

  expect(name).toBe('web-a1a1a1a1');
});

test('it cuts a long name before it adds the digest tag', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, {
    name: 'a-name-longer-than-the-tag-allows',
    ref: 'imp/long:1',
    digest: `sha256:${'b2'.repeat(32)}`,
    sizeBytes: 1,
    source: 'oci',
    sourceImp: null,
  });

  const name = await resolveImportedImageName(
    ctx.db,
    'a-name-longer-than-the-tag-allows',
    `sha256:${'c3'.repeat(32)}`,
  );

  expect(name).toBe('a-name-longer-than-the-c3c3c3c3');
});

test('it refuses an image whose name and tagged name are both taken', async () => {
  const ctx = await setupTest();

  await createImage(ctx.db, {
    name: 'web',
    ref: 'imp/web:1',
    digest: `sha256:${'b2'.repeat(32)}`,
    sizeBytes: 1,
    source: 'oci',
    sourceImp: null,
  });

  await createImage(ctx.db, {
    name: 'web-a1a1a1a1',
    ref: 'imp/web:2',
    digest: `sha256:${'d4'.repeat(32)}`,
    sizeBytes: 1,
    source: 'oci',
    sourceImp: null,
  });

  expect(
    resolveImportedImageName(ctx.db, 'web', `sha256:${'a1'.repeat(32)}`),
  ).rejects.toMatchObject({
    code: 'CONFLICT',
    message: 'images web and web-a1a1a1a1 both exist; remove one to import this image',
  });
});
