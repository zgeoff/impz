import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestImpd } from '../testing/start-test-impd';
import { listImages } from './platform/db/images';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const host = await startTestImpd(stack, {
    frozenClockMs: Date.parse('2026-10-01T00:00:00Z'),
    env: { IMP_IMAGE_PRUNE_ROLLBACK: '1' },
  });

  return { host };
}

test('it prunes the old unused agent images past the rollback count each hour, with no build', async () => {
  const ctx = await setupTest();

  await ctx.host.createTestImage('agent-1111111');
  await ctx.host.createTestImage('agent-2222222');
  await ctx.host.createTestImage('agent-3333333');

  writeFileSync(join(ctx.host.dataDir, 'image-keep'), '');

  for (const [name, lastUsedAt] of [
    ['agent-1111111', '2026-08-01T00:00:00Z'],
    ['agent-2222222', '2026-08-02T00:00:00Z'],
    ['agent-3333333', '2026-08-03T00:00:00Z'],
  ] as const) {
    await ctx.host.db
      .updateTable('images')
      .set({ last_used_at: Date.parse(lastUsedAt) })
      .where('name', '=', name)
      .execute();
  }

  const delayMs = ctx.host.tickers.readDelays()['image-prune'];

  await ctx.host.tickers.fire('image-prune');

  const images = await listImages(ctx.host.db);

  expect(delayMs).toBe(3_600_000);
  expect(images.map((image) => image.name)).toStrictEqual(['agent-3333333']);
});
