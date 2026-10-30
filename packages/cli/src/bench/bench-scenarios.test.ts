import { expect, onTestFinished, test } from 'bun:test';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import invariant from 'tiny-invariant';
import { startImpdHost } from '../test-utils/start-impd-host';
import { BENCH_SCENARIOS } from './bench-scenarios';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const box = await startImpdHost(stack, { env: {} });

  return { box };
}

test('it restores the checkpoint that the restore arrange found, with no lookup in its timed step', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const restore = BENCH_SCENARIOS.find((scenario) => scenario.name === 'restore');

  invariant(restore);

  const step = await restore.arrange({
    client: ctx.box.client,
    name: 'bench-restore',
    settings: { memoryMib: null, image: 'base', awakeMs: 0 },
    wait: () => Promise.resolve(),
  });

  const [arranged] = await ctx.box.client.checkpoints.list({ name: 'bench-restore' });

  invariant(arranged);

  await ctx.box.client.checkpoints.delete({ name: 'bench-restore', checkpoint: arranged.id });
  await ctx.box.client.checkpoints.create({ name: 'bench-restore', label: 'bench' });

  expect(step()).rejects.toMatchObject({ code: 'NOT_FOUND' });
});
