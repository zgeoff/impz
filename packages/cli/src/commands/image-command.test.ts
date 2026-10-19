import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { createImage } from '@impz/daemon/src/db/images';
import { DOCKERFILE_FRONTEND } from '@impz/daemon/src/docker-proxy/dockerfile-frontend';
import {
  buildImagePaths,
  buildMockNewImage,
  buildStubTracedBuild,
  createStubDockerCli,
  startStubDockerEngine,
  startTestImpd,
} from '@impz/daemon/testing';
import { updateEnv } from '@impz/test-utils/update-env';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import * as z from 'zod';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';

// impd's real app, listening on a loopback port for the spawned CLI
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const dataDir = await mkdtemp(join(tmpdir(), 'cli-image-'));

  stack.defer(() => rm(dataDir, { recursive: true, force: true }));

  // the engine a host build sends its context to
  const engine = startStubDockerEngine({ dir: dataDir });

  stack.defer(() => engine.stop());

  // impd boots with a root bearer; each test reads it back for the CLI
  const rootToken = faker.string.alphanumeric(32);

  // builds run on the host's engine, the stub
  const harness = await startTestImpd(stack, {
    dataDir,
    rootToken,
    env: { IMP_BUILD_ISOLATION: 'host', DOCKER_HOST: engine.dockerHost },
  });

  return {
    rootToken,
    db: harness.db,
    dataDir,
    engine,
    url: harness.url,
  };
}

test('#imageCommand prints progress lines and the step output of a build whose stderr is no terminal', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);

  expect(result.stderr.split('\n')).toIncludeAllMembers([
    expect.stringMatching(/^impz image build: uploading, 0m\d\ds$/v),
    expect.stringMatching(/^impz image build: building, 0m\d\ds$/v),
    expect.stringMatching(
      /^impz image build: building, 0m\d\ds, \[2\/3\] RUN echo compiling widget && echo second line$/v,
    ),
    '#1 [2/3] RUN echo compiling widget && echo second line',
    '#1 compiling widget',
    '#1 second line',
    expect.stringMatching(/^impz image build: unpacking, 0m\d\ds, \[2\/3\] RUN echo compiling/v),
  ]);

  expect(result.stdout).toStartWith('NAME');
  expect(ctx.engine.unexpected).toStrictEqual([]);
});

test('#imageCommand prints no progress and no step output for --quiet', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).toStartWith('NAME');
});

test('#imageCommand prints the image as JSON alone on stdout with --json, and the progress on stderr', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}` }));

  const result = await runCLIInProcess({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '--json'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const printed: unknown = JSON.parse(result.stdout);

  expect(result.code).toBe(0);
  expect(printed).toMatchObject({ name: 'web', ref: 'imp/web:latest', source: 'oci' });
  expect(result.stderr).toInclude('#1 compiling widget\n');
});

test('#imageCommand lists a running build with its start and step from another shell', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.dataDir, 'context'));
  await writeFile(join(ctx.dataDir, 'context', 'Dockerfile'), 'FROM scratch\n');
  await mkdir(join(ctx.dataDir, 'tree'));
  await writeFile(join(ctx.dataDir, 'tree', 'hello'), 'hi');

  const docker = createStubDockerCli({
    dir: ctx.dataDir,
    images: [
      { refs: [DOCKERFILE_FRONTEND], inspects: [{ Id: `sha256:${'f'.repeat(64)}` }] },
      {
        refs: ['imp/web:latest'],
        inspects: [{ Id: `sha256:${'e'.repeat(64)}`, Config: {}, Size: 2 }],
      },
    ],
    create: { id: 'c'.repeat(64) },
    exportTar: Bun.spawnSync(['tar', '-C', join(ctx.dataDir, 'tree'), '-c', 'hello']).stdout,
  });

  // the engine holds the build in its RUN step until the listing is read
  const hold = Promise.withResolvers<void>();

  onTestFinished(() => {
    hold.resolve();
  });

  updateEnv('PATH', docker.path);

  ctx.engine.setAnswer(
    buildStubTracedBuild({ imageId: `sha256:${'e'.repeat(64)}`, hold: hold.promise }),
  );

  const before = new Date();

  const building = runCLIInProcess({
    args: ['image', 'build', join(ctx.dataDir, 'context'), '--name', 'web', '-q'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  const listedJson = await waitFor(async () => {
    const result = await runCLIInProcess({
      args: ['image', 'builds', '--json'],
      env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
    });

    const builds = z
      .array(z.object({ step: z.string().nullable() }))
      .parse(JSON.parse(result.stdout));

    invariant(typeof builds[0]?.step === 'string');

    return result.stdout;
  });

  const listed: unknown = JSON.parse(listedJson);

  const table = await runCLIInProcess({
    args: ['image', 'builds'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
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
      phase: 'build',
      step: '[2/3] RUN echo compiling widget && echo second line',
      builder: null,
    },
  ]);

  const tableLines: unknown = table.stdout.split('\n');

  expect(tableLines).toStrictEqual([
    expect.stringMatching(/^NAME +SOURCE +STARTED +ELAPSED +PHASE +STEP +BUILDER *$/v),
    expect.stringMatching(
      /^web +upload +\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ +\d+s +build +\[2\/3\] RUN echo compiling widget && echo second line +- *$/v,
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

test('#templateCommand refuses to remove a docker image as a template', async () => {
  const ctx = await setupTest();

  // a docker image, with a rootfs where its digest names
  const image = buildMockNewImage({ name: 'ubuntu', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.db, image);

  const result = await runCLIInProcess({
    args: ['template', 'rm', 'ubuntu'],
    env: { IMP_URL: ctx.url, IMP_TOKEN: ctx.rootToken },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: ubuntu is a docker image, not a template: use impz image rm\n',
    code: 2,
  });
});
