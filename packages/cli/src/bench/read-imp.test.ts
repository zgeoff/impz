import { expect, onTestFinished, test } from 'bun:test';
import { createImpClient } from '@impz/client';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import { claimFreePorts } from '@impz/test-utils/claim-free-ports';
import { startImpdHost } from '../test-utils/start-impd-host';
import { readImp } from './read-imp';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const box = await startImpdHost(stack, { env: {} });

  return { box };
}

test('it reads the imp under a name', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const created = await ctx.box.client.imps.create({ name: 'bench-fern', image: 'base' });
  const imp = await readImp(ctx.box.client, 'bench-fern');

  expect(imp?.id).toBe(created.id);
});

test('it reads a name with no imp as null', async () => {
  const ctx = await setupTest();
  const imp = await readImp(ctx.box.client, 'bench-absent');

  expect(imp).toBeNull();
});

test('it throws a failure other than a missing imp', () => {
  const port = claimFreePorts(1).take();
  const client = createImpClient({ url: `http://127.0.0.1:${String(port)}` });

  expect(readImp(client, 'bench-unreached')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
});
