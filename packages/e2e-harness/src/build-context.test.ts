import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { buildStubImageBuilder, createFilesTar, startBuilderImpd } from '@impz/daemon/testing';
import { runRawBuild, writeBuildContext } from './build-context';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  stack.defer(() => rm(root, { recursive: true, force: true }));

  const rootToken = faker.string.alphanumeric(32);

  // impd listens with its own body limit, so the build route, not Bun, refuses
  // a large context.
  const startImpd = async (builder: Parameters<typeof startBuilderImpd>[1]) => {
    const harness = await startBuilderImpd(stack, builder, {
      dataDir: join(root, 'data'),
      rootToken,
    });

    return harness.url;
  };

  return {
    root,
    rootToken,
    startImpd,
  };
}

test('#writeBuildContext makes a named directory that holds the Dockerfile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'build-context-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  const directory = await writeBuildContext(root, 'syntax', 'FROM busybox:1.37\n');
  const dockerfile = await readFile(join(root, 'syntax', 'Dockerfile'), 'utf8');

  expect(directory).toBe(join(root, 'syntax'));
  expect(dockerfile).toBe('FROM busybox:1.37\n');
});

test('#runRawBuild builds a tar of exactly the named files on impd under the token and image name', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.root, { hello: 'built\n' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const apiUrl = await ctx.startImpd(builder);
  const directoryPath = await writeBuildContext(ctx.root, 'ctx', 'FROM scratch\nCOPY kept.txt /\n');

  await writeFile(join(directoryPath, 'kept.txt'), 'kept');
  await writeFile(join(directoryPath, 'left-out.txt'), 'left out');

  const built = await runRawBuild({
    apiUrl,
    token: ctx.rootToken,
    directoryPath,
    files: ['Dockerfile', 'kept.txt'],
    name: 'e2e-img-raw',
  });

  const listed = Bun.spawnSync(['tar', '-tf', '-'], {
    stdin: builder.builtContexts.at(0) ?? new Uint8Array(),
  }).stdout.toString();

  expect(built).toMatchObject({ name: 'e2e-img-raw', ref: 'imp/e2e-img-raw:latest' });
  expect(listed).toBe('Dockerfile\nkept.txt\n');
});

test('#runRawBuild throws impd’s refusal of another token', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const apiUrl = await ctx.startImpd(builder);
  const directoryPath = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  expect(
    runRawBuild({
      apiUrl,
      token: 'imp_wrong',
      directoryPath,
      files: ['Dockerfile'],
      name: 'e2e-img-raw',
    }),
  ).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
});

test('#runRawBuild throws with tar’s reason when a named file is missing', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const apiUrl = await ctx.startImpd(builder);
  const directoryPath = await writeBuildContext(ctx.root, 'ctx', 'FROM busybox:1.37\n');

  expect(
    runRawBuild({
      apiUrl,
      token: ctx.rootToken,
      directoryPath,
      files: ['missing.txt'],
      name: 'e2e-img-raw',
    }),
  ).rejects.toThrowWithMessage(Error, /^tar exited 2: .*missing\.txt/u);
});
