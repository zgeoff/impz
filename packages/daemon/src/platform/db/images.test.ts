import { expect, test } from 'bun:test';
import { buildMockNewImage } from '../../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../../testing/platform/create-test-database';
import {
  countImageDigestUses,
  createImage,
  listImageRemovals,
  listImageUses,
  listImages,
  readImageByDigest,
  readImageById,
  readImageByName,
  removeImage,
  removeImageRemoval,
  removeUnusedImage,
  updateImage,
  updateImagePin,
  updateImageReceivedDigest,
  updateImageUse,
} from './images';
import { createImp } from './imps';

test('#createImage returns the stored image, a docker image by default', async () => {
  const ctx = await createTestDatabase();

  const image = await createImage(
    ctx.db,
    buildMockNewImage({
      name: 'dev',
      ref: 'imp/hello:latest',
      digest: 'sha256:1111',
      sizeBytes: 2048,
    }),
  );

  expect(image).toStrictEqual({
    id: expect.toBeString(),
    name: 'dev',
    ref: 'imp/hello:latest',
    digest: 'sha256:1111',
    receivedDigest: null,
    source: 'oci',
    sourceImp: null,
    sizeBytes: 2048,
    createdAt: expect.toBeValidDate(),
    isPinned: false,
  });
});

test('#createImage keeps the source imp of a template', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ source: 'imp', sourceImp: 'dev' }));

  expect(image).toMatchObject({ source: 'imp', sourceImp: 'dev' });
});

test('#createImage rejects a duplicate image name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  expect(createImage(ctx.db, buildMockNewImage({ name: 'base' }))).rejects.toThrowWithMessage(
    Error,
    /UNIQUE constraint failed: images\.name/u,
  );
});

test('#readImageByName finds the image of that name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const dev = await createImage(ctx.db, buildMockNewImage({ name: 'dev' }));
  const found = await readImageByName(ctx.db, 'dev');

  expect(found).toStrictEqual(dev);
});

test('#readImageByName finds nothing for a name no image has', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const found = await readImageByName(ctx.db, 'dev');

  expect(found).toBeUndefined();
});

test('#readImageById finds the image of that id', async () => {
  const ctx = await createTestDatabase();
  const dev = await createImage(ctx.db, buildMockNewImage());
  const found = await readImageById(ctx.db, dev.id);

  expect(found).toStrictEqual(dev);
});

test('#readImageByDigest finds the oldest image of that digest', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('images')
    .values([
      { id: 'b', name: 'newer', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 20 },
      { id: 'c', name: 'older', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
      { id: 'a', name: 'other', ref: 'r', digest: 'sha256:2222', size_bytes: 1, created_at: 0 },
    ])
    .execute();

  const found = await readImageByDigest(ctx.db, ['sha256:1111']);

  expect(found?.name).toBe('older');
});

test('#readImageByDigest finds an image by the digest this host recorded for its copy on another host', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('images')
    .values([
      { id: 'a', name: 'other', ref: 'r', digest: 'sha256:2222', size_bytes: 1, created_at: 0 },
      {
        id: 'b',
        name: 'pulled',
        ref: 'r',
        digest: 'sha256:1111',
        received_digest: 'sha256:3333',
        size_bytes: 1,
        created_at: 10,
      },
    ])
    .execute();

  const found = await readImageByDigest(ctx.db, ['sha256:9999', 'sha256:3333']);

  expect(found?.name).toBe('pulled');
});

test('#readImageByDigest breaks a tie in age by id', async () => {
  const ctx = await createTestDatabase();

  await ctx.db
    .insertInto('images')
    .values([
      { id: 'b', name: 'second', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
      { id: 'a', name: 'first', ref: 'r', digest: 'sha256:1111', size_bytes: 1, created_at: 10 },
    ])
    .execute();

  const found = await readImageByDigest(ctx.db, ['sha256:1111']);

  expect(found?.name).toBe('first');
});

test('#readImageByDigest finds nothing for a digest no image has', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  const found = await readImageByDigest(ctx.db, ['sha256:2222']);

  expect(found).toBeUndefined();
});

test('#listImages lists every image by name', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'dev' }));
  await createImage(ctx.db, buildMockNewImage({ name: 'base' }));

  const images = await listImages(ctx.db);

  expect(images.map((image) => image.name)).toStrictEqual(['base', 'dev']);
});

test('#updateImage points the image at the new build and keeps its name', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ name: 'base', source: 'imp' }));

  const updated = await updateImage(ctx.db, image.id, {
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    sizeBytes: 4096,
    sourceImp: 'dev',
  });

  expect(updated).toStrictEqual({
    id: image.id,
    name: 'base',
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    receivedDigest: null,
    source: 'imp',
    sourceImp: 'dev',
    sizeBytes: 4096,
    createdAt: image.createdAt,
    isPinned: false,
  });
});

test('#updateImage drops the received digest of the build it replaces', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  await updateImageReceivedDigest(ctx.db, image, 'sha256:3333');

  const updated = await updateImage(ctx.db, image.id, {
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    sizeBytes: 4096,
  });

  expect(updated.receivedDigest).toBeNull();
});

test('#updateImageReceivedDigest records the digest of the image as another host received it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  await updateImageReceivedDigest(ctx.db, image, 'sha256:3333');

  const read = await readImageById(ctx.db, image.id);

  expect(read?.receivedDigest).toBe('sha256:3333');
});

test('#updateImageReceivedDigest records nothing on an image rebuilt since the send read it', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  await updateImage(ctx.db, image.id, { ref: 'imp/base:v2', digest: 'sha256:2222', sizeBytes: 1 });
  await updateImageReceivedDigest(ctx.db, image, 'sha256:3333');

  const read = await readImageById(ctx.db, image.id);

  expect(read?.receivedDigest).toBeNull();
});

test('#updateImage clears the source imp when the build names none', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ sourceImp: 'dev' }));

  const updated = await updateImage(ctx.db, image.id, {
    ref: 'imp/base:v2',
    digest: 'sha256:2222',
    sizeBytes: 4096,
  });

  expect(updated.sourceImp).toBeNull();
});

test('#countImageDigestUses counts the images of that digest', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));
  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));
  await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:2222' }));

  const uses = await countImageDigestUses(ctx.db, 'sha256:1111');

  expect(uses).toBe(2);
});

test('#removeImage refuses to remove an image an imp still uses', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  expect(removeImage(ctx.db, image.id)).rejects.toThrowWithMessage(
    Error,
    /FOREIGN KEY constraint failed/u,
  );
});

test('#removeImage reports an unused image as removed', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());
  const isRemoved = await removeImage(ctx.db, image.id);

  expect(isRemoved).toBeTrue();
});

test('#removeImage reports an image that is gone already as not removed', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await removeImage(ctx.db, image.id);

  const isRemoved = await removeImage(ctx.db, image.id);

  expect(isRemoved).toBeFalse();
});

test('#listImageUses lists each image with its last use and the imps that use it', async () => {
  const ctx = await createTestDatabase();

  const image = await createImage(
    ctx.db,
    buildMockNewImage({ name: 'web-0a1b2c3', digest: 'sha256:1111', sizeBytes: 2048 }),
  );

  await createImage(ctx.db, buildMockNewImage({ name: 'base', source: 'imp' }));
  await updateImagePin(ctx.db, 'base', true);
  await createImp(ctx.db, buildMockNewImp({ name: 'one', imageId: image.id }));

  await createImp(
    ctx.db,
    buildMockNewImp({ name: 'two', imageId: image.id, slot: 1, ip: '10.66.0.6' }),
  );

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));

  const uses = await listImageUses(ctx.db);

  expect(uses).toStrictEqual([
    {
      id: expect.toBeString(),
      name: 'base',
      digest: expect.toBeString(),
      source: 'imp',
      sizeBytes: expect.toBeNumber(),
      lastUsedAt: expect.toBeWithin(Date.now() - 60_000, Date.now() + 1),
      impCount: 0,
      isPinned: true,
    },
    {
      id: image.id,
      name: 'web-0a1b2c3',
      digest: 'sha256:1111',
      source: 'oci',
      sizeBytes: 2048,
      lastUsedAt: Date.parse('2030-01-01T00:00:00Z'),
      impCount: 2,
      isPinned: false,
    },
  ]);
});

test('#updateImageUse never moves a last use back', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ name: 'web-0a1b2c3' }));

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-02T00:00:00Z'));
  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));

  const uses = await listImageUses(ctx.db);

  expect(uses[0]?.lastUsedAt).toBe(Date.parse('2030-01-02T00:00:00Z'));
});

test('#updateImageUse records a use of an image named by its received digest', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1111' }));

  await updateImageReceivedDigest(ctx.db, image, 'sha256:3333');

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  await updateImageUse(ctx.db, 'digest', ['sha256:3333'], Date.parse('2030-01-02T00:00:00Z'));

  const uses = await listImageUses(ctx.db);

  expect(uses[0]?.lastUsedAt).toBe(Date.parse('2030-01-02T00:00:00Z'));
});

test('#updateImage records the rebuild as a use of the image', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ name: 'web-0a1b2c3' }));

  await ctx.db.updateTable('images').set({ last_used_at: 0 }).execute();

  await updateImage(ctx.db, image.id, {
    ref: 'imp/agent:latest',
    digest: 'sha256:2',
    sizeBytes: 1,
  });

  const uses = await listImageUses(ctx.db);

  expect(uses[0]?.lastUsedAt).toBeWithin(Date.now() - 60_000, Date.now() + 1);
});

test('#removeUnusedImage removes an image no imp uses at the last use the caller read', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));

  const isRemoved = await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));
  const stored = await readImageById(ctx.db, image.id);

  expect(isRemoved).toBeTrue();
  expect(stored).toBeUndefined();
});

test('#removeUnusedImage keeps an image an imp uses', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));
  await createImp(ctx.db, buildMockNewImp({ imageId: image.id }));

  const isRemoved = await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));
  const stored = await readImageById(ctx.db, image.id);

  expect(isRemoved).toBeFalse();
  expect(stored).toMatchObject({ id: image.id });
});

test('#removeUnusedImage keeps a pinned image', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ name: 'kept' }));

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));
  await updateImagePin(ctx.db, 'kept', true);

  const isRemoved = await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));
  const stored = await readImageById(ctx.db, image.id);

  expect(isRemoved).toBeFalse();
  expect(stored).toMatchObject({ id: image.id });
});

test('#updateImagePin pins an image and returns it', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'kept' }));

  const pinned = await updateImagePin(ctx.db, 'kept', true);

  expect(pinned?.isPinned).toBeTrue();
});

test('#updateImagePin unpins a pinned image', async () => {
  const ctx = await createTestDatabase();

  await createImage(ctx.db, buildMockNewImage({ name: 'kept' }));
  await updateImagePin(ctx.db, 'kept', true);

  const unpinned = await updateImagePin(ctx.db, 'kept', false);

  expect(unpinned?.isPinned).toBeFalse();
});

test('#updateImagePin returns nothing for a name no image has', async () => {
  const ctx = await createTestDatabase();
  const pinned = await updateImagePin(ctx.db, 'missing', true);

  expect(pinned).toBeUndefined();
});

test('#removeUnusedImage records the digest of the image it removes, for its rootfs removal', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1' }));

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));
  await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual(['sha256:1']);
});

test('#removeUnusedImage records no digest when it keeps the image', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1' }));

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-02T00:00:00Z'));
  await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual([]);
});

test('#removeImage records the digest of the image it removes, for its rootfs removal', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1' }));

  await removeImage(ctx.db, image.id);

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual(['sha256:1']);
});

test('#removeImageRemoval drops the record of a removed rootfs', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage({ digest: 'sha256:1' }));

  await removeImage(ctx.db, image.id);
  await removeImageRemoval(ctx.db, 'sha256:1');

  const removals = await listImageRemovals(ctx.db);

  expect(removals).toStrictEqual([]);
});

test('#removeUnusedImage keeps an image used again since the caller read its last use', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-01T00:00:00Z'));
  await updateImageUse(ctx.db, 'id', [image.id], Date.parse('2030-01-02T00:00:00Z'));

  const isRemoved = await removeUnusedImage(ctx.db, image.id, Date.parse('2030-01-01T00:00:00Z'));
  const stored = await readImageById(ctx.db, image.id);

  expect(isRemoved).toBeFalse();
  expect(stored).toMatchObject({ id: image.id });
});
