import { expect, test } from 'bun:test';
import { buildMockNewImage } from '../../testing/imps/build-mock-new-image';
import { buildMockNewImp } from '../../testing/imps/build-mock-new-imp';
import { createTestDatabase } from '../../testing/platform/create-test-database';
import { createImage } from './images';
import { createImp } from './imps';
import { isSlotFree } from './is-slot-free';

test('#isSlotFree reports a slot an imp holds as taken', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 3 }));

  const isFree = await isSlotFree(ctx.db, 3, Date.now());

  expect(isFree).toBeFalse();
});

test('#isSlotFree reports a slot no imp or ticket holds as free', async () => {
  const ctx = await createTestDatabase();
  const image = await createImage(ctx.db, buildMockNewImage());

  await createImp(ctx.db, buildMockNewImp({ imageId: image.id, slot: 3 }));

  const isFree = await isSlotFree(ctx.db, 2, Date.now());

  expect(isFree).toBeTrue();
});
