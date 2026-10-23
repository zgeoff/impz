import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readImageByName } from '../../src/platform/db/images';
import { runChecked } from '../../src/platform/process/run-command';
import { buildStubImageBuilder } from './build-stub-image-builder';
import { createFilesTar } from './create-files-tar';
import { startBuilderImpd } from './start-builder-impd';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'builder-impd-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it adds an image through its stub builder, which runs the pull', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'from the stub\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: join(ctx.directoryPath, 'data'),

    cloneDisk: async (source, target) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
  });

  const image = await harness.client.images.add({ ref: 'busybox:1.37', name: 'box' });

  expect(image).toMatchObject({ name: 'box', ref: 'busybox:1.37' });

  expect(builder.guest.runs.map((run) => run.argv.slice(1).join(' '))).toContain(
    'pull --quiet --platform linux/amd64 busybox:1.37',
  );
});

test('it holds the builder image under the ref the config names', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: join(ctx.directoryPath, 'data'),
  });

  const held = await readImageByName(harness.db, 'imp-builder');

  expect(held?.ref).toBe(harness.config.build.image);
});
