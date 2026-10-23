import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubImageBuilder,
  createFilesTar,
  createImage,
  readImageByName,
  startBuilderImpd,
  startTestImpd,
  updateImagePin,
} from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'cli-image-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return {
    stack,
    directoryPath: directory,
    dataDir: join(directory, 'data'),
    rootToken: faker.string.alphanumeric(32),
  };
}

test('#imageCommand prints progress lines and the step output of a build whose stderr is no terminal', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'e'.repeat(64)}`,
    buildLog:
      '#5 [2/3] RUN echo compiling widget && echo second line\n#5 0.112 compiling widget\n#5 0.113 second line\n#5 DONE 0.2s\n',
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.directoryPath, 'context'), '--name', 'web'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);

  expect(result.stderr.split('\n')).toIncludeAllMembers([
    expect.stringMatching(/^impz image build: uploading, 0m\d\ds$/v),
    expect.stringMatching(/^impz image build: building, 0m\d\ds$/v),
    expect.stringMatching(
      /^impz image build: building, 0m\d\ds, \[2\/3\] RUN echo compiling widget && echo second line$/v,
    ),
    '#5 [2/3] RUN echo compiling widget && echo second line',
    '#5 0.112 compiling widget',
    '#5 0.113 second line',
    expect.stringMatching(/^impz image build: unpacking, 0m\d\ds, \[2\/3\] RUN echo compiling/v),
  ]);

  expect(result.stdout).toStartWith('NAME');
});

test('#imageCommand prints no progress and no step output for --quiet', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'e'.repeat(64)}`,
    buildLog: '#5 [2/3] RUN echo compiling widget\n#5 0.112 compiling widget\n#5 DONE 0.2s\n',
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.directoryPath, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toStartWith('NAME');
});

test('#imageCommand prints the image as JSON alone on stdout with --json, and the progress on stderr', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'e'.repeat(64)}`,
    buildLog: '#5 [2/3] RUN echo compiling widget\n#5 0.112 compiling widget\n#5 DONE 0.2s\n',
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.directoryPath, 'context'), '--name', 'web', '--json'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(result.code).toBe(0);
  expect(printed).toMatchObject({ name: 'web', ref: 'imp/web:latest', source: 'oci' });
  expect(result.stderr).toInclude('#5 0.112 compiling widget\n');
});

test('#imageCommand lists a running build with its start, step and builder from another shell', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const hold = Promise.withResolvers<void>();

  onTestFinished(() => {
    hold.resolve();
  });

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    onExport: () => hold.promise,
    repoDigest: `sha256:${'e'.repeat(64)}`,
    buildLog:
      '#5 [2/3] RUN echo compiling widget && echo second line\n#5 0.112 compiling widget\n#5 DONE 0.2s\n',
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  const before = new Date();

  const building = runCLIInProcess({
    args: ['image', 'build', join(ctx.directoryPath, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  const listedJson = await waitFor(async () => {
    const result = await runCLIInProcess({
      args: ['image', 'builds', '--json'],
      env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
    });

    const builds = z.array(z.object({ phase: z.string() })).parse(JSON.parse(result.stdout));

    invariant(builds[0]?.phase === 'unpack');

    return result.stdout;
  });

  const listed: unknown = JSON.parse(listedJson);

  const table = await runCLIInProcess({
    args: ['image', 'builds'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  hold.resolve();

  const built = await building;

  expect(listed).toStrictEqual([
    {
      name: 'web',
      source: 'upload',
      startedAt: expect.toSatisfy(
        (startedAt: string) => Date.parse(startedAt) >= before.getTime() - 1000,
      ),
      phase: 'unpack',
      step: '[2/3] RUN echo compiling widget && echo second line',
      builder: expect.stringMatching(/^imp-build-[a-z0-9]{8}$/v),
    },
  ]);

  const tableLines: unknown = table.stdout.split('\n');

  expect(tableLines).toStrictEqual([
    expect.stringMatching(/^NAME +SOURCE +STARTED +ELAPSED +PHASE +STEP +BUILDER *$/v),
    expect.stringMatching(
      /^web +upload +\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ +\d+s +unpack +\[2\/3\] RUN echo compiling widget && echo second line +imp-build-[a-z0-9]{8} *$/v,
    ),
    '',
  ]);

  expect(built.code).toBe(0);
});

test('#imageCommand refuses a relative path for --on-host, which names no directory on the impd host', async () => {
  const result = await runCLIInProcess({
    args: ['image', 'build', 'images/base', '--name', 'base', '--on-host'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: --on-host takes an absolute path on the impd host, not images/base\n',
    code: 2,
  });
});

test('#imageCommand refuses a build context without a Dockerfile before any upload', async () => {
  const context = await mkdtemp(join(tmpdir(), 'imp-empty-context-'));

  onTestFinished(() => rm(context, { recursive: true, force: true }));

  const result = await runCLIInProcess({
    args: ['image', 'build', context, '--name', 'base'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  const received: unknown = result;

  expect(received).toStrictEqual({
    stdout: '',
    stderr: expect.stringMatching(/^impz: there is no Dockerfile in /u) as unknown,
    code: 2,
  });
});

test('#imageCommand pins an image so that image ls shows it pinned', async () => {
  const ctx = await setupTest();

  const harness = await startTestImpd(ctx.stack, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  await createImage(harness.db, buildMockNewImage({ name: 'ubuntu' }));

  const result = await runCLIInProcess({
    args: ['image', 'pin', 'ubuntu'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  const image = await readImageByName(harness.db, 'ubuntu');

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });
  expect(image?.isPinned).toBeTrue();
});

test('#imageCommand unpins a pinned image', async () => {
  const ctx = await setupTest();

  const harness = await startTestImpd(ctx.stack, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  await createImage(harness.db, buildMockNewImage({ name: 'ubuntu' }));
  await updateImagePin(harness.db, 'ubuntu', true);

  const result = await runCLIInProcess({
    args: ['image', 'unpin', 'ubuntu'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  const image = await readImageByName(harness.db, 'ubuntu');

  expect(result).toStrictEqual({ stdout: '', stderr: '', code: 0 });
  expect(image?.isPinned).toBeFalse();
});

test('#templateCommand refuses to remove a docker image as a template', async () => {
  const ctx = await setupTest();

  const harness = await startTestImpd(ctx.stack, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
  });

  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(harness.db, image);

  const result = await runCLIInProcess({
    args: ['template', 'rm', 'ubuntu'],
    env: { IMP_URL: harness.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: ubuntu is a docker image, not a template: use impz image rm\n',
    code: 2,
  });
});
