import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubImageBuilder } from '../imps/build-stub-image-builder';
import { createFilesTar } from '../imps/create-files-tar';
import { startBuilderImpd } from '../imps/start-builder-impd';
import { runUploadedBuild } from './run-uploaded-build';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'run-uploaded-build-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory, rootToken: 'uploaded-build-root' };
}

test('it uploads the context, then answers every event of the build stream, the image last', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: join(ctx.directoryPath, 'data'),
    rootToken: ctx.rootToken,
  });

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const events = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  });

  const first: unknown = events[0];

  expect(first).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: expect.any(Number) as unknown,
  });

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\n']);
});

test('it throws the refusal of the upload with its code and status', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: join(ctx.directoryPath, 'data'),
    rootToken: ctx.rootToken,
  });

  expect(
    runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=Bad', body: 'tar' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST', status: 400 });
});

test('it throws the error that ends the build stream', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: join(ctx.directoryPath, 'data'),
    rootToken: ctx.rootToken,
  });

  expect(
    runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: 'not a tar' }),
  ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
