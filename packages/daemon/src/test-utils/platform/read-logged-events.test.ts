import { expect, test } from 'bun:test';
import { createImage } from '../../platform/db/images';
import { createImp, removeImp } from '../../platform/db/imps';
import { buildMockNewImage } from '../imps/build-mock-new-image';
import { buildMockNewImp } from '../imps/build-mock-new-imp';
import { createTestDatabase } from './create-test-database';
import { readLoggedEvents } from './read-logged-events';

function setupTest() {
  return createTestDatabase();
}

test('it returns the events after the seq, in order', async () => {
  const ctx = await setupTest();
  const image = await createImage(ctx.db, buildMockNewImage());
  const imp = await createImp(ctx.db, buildMockNewImp({ name: 'tidy-heron', imageId: image.id }));
  const head = await ctx.db.log.readHead();

  await removeImp(ctx.db, imp.id);

  const logged = await readLoggedEvents(ctx.db, head);

  expect(logged).toStrictEqual([{ ev: 'ImpRemoved', imp, seq: head + 1, at: expect.any(Date) }]);
});

test('it returns an empty list when nothing came after the seq', async () => {
  const ctx = await setupTest();
  const head = await ctx.db.log.readHead();
  const logged = await readLoggedEvents(ctx.db, head);

  expect(logged).toStrictEqual([]);
});
