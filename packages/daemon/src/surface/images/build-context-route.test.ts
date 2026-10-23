import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import {
  IMAGE_BUILD_PATH,
  IMAGE_BUILD_STREAM_TYPE,
  ImageBuildEventSchema,
  ImageBuildResultSchema,
} from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockCaller } from '../../../testing/identity/build-mock-caller';
import { buildStubImageBuilder } from '../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { startBuilderImpd } from '../../../testing/imps/start-builder-impd';
import type { StubAnswer } from '../../../testing/vm/build-stub-guest';
import { DOCKERFILE_FRONTEND } from '../../imps/docker-contract/dockerfile-frontend';
import { PIN_INSPECT_FORMAT } from '../../imps/images/image-pin';
import { createForwardedPeers } from '../../network/proxy/forwarded-peers';
import { startWakeProxy } from '../../network/proxy/wake-proxy';
import { createApiAudit } from '../../platform/audit/api-audit';
import { listApiCalls } from '../../platform/db/api-audit';
import { runChecked } from '../../platform/process/run-command';
import { buildUploadsDir } from '../../vm/storage/data-layout';
import { readErrorCode } from '../read-error-code';
import { toApiImage } from '../to-api-image';
import { createBuildContextRoute } from './build-context-route';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'build-context-route-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return {
    stack,
    directoryPath: directory,
    dataDir: join(directory, 'data'),
    rootToken: faker.string.alphanumeric(32),

    // A sparse copy stands in for a reflink, because the temp dir is not XFS.
    cloneDisk: async (source: string, target: string) => {
      await runChecked(['cp', '--sparse=always', source, target]);
    },
  };
}

test('it builds an uploaded context and answers the image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(200);
  expect(ImageBuildResultSchema.parse(body).name).toBe('web');
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\n']);
});

test('it runs the build in the builder on the context with the Dockerfile path it names', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context', 'docker'), { recursive: true });
  await writeFile(join(ctx.directoryPath, 'context', 'docker', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'docker',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web&dockerfile=docker/Dockerfile`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const builds = builder.guest.runs.filter((run) => run.argv[1] === 'build').map((run) => run.argv);

  expect(builds).toStrictEqual([
    [
      'docker',
      'build',
      '--progress=plain',
      '--build-arg',
      `BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND}`,
      '--tag',
      'imp-build:latest',
      '--file',
      'docker/Dockerfile',
      '-',
    ],
  ]);
});

test('it removes the upload and audits the build as ok once the build ends', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(outcomes).toStrictEqual(['ok']);
  expect(uploads).toStrictEqual([]);
});

test('it answers a streamed build with its headers while the build still runs', async () => {
  const ctx = await setupTest();

  const held = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await held.promise;

      return { code: 1, stderr: 'held for the test\n' };
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}`, accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  ctx.stack.defer(async () => {
    held.resolve();

    await response.text();
  });

  expect([response.status, response.headers.get('content-type')]).toStrictEqual([
    200,
    IMAGE_BUILD_STREAM_TYPE,
  ]);
});

test('it streams progress lines while the build runs, then the image', async () => {
  const ctx = await setupTest();

  const gate = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await gate.promise;

      return { stderr: '#1 DONE\n' };
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10,
  });

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  const read = { text: '' };

  while (read.text.split('"phase":"build"').length <= 3) {
    const chunk = await reader?.read();

    read.text += chunk?.value ?? '';
  }

  gate.resolve();

  for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
    read.text += chunk.value;
  }

  const events = read.text
    .trim()
    .split('\n')
    .map((line) => ImageBuildEventSchema.parse(JSON.parse(line)));

  expect(events[0]).toMatchObject({ type: 'progress', phase: 'upload' });
  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
});

test('it streams the step and output of a running build, and lists it in images.builds until it ends', async () => {
  const ctx = await setupTest();

  const gate = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    buildLog:
      '#1 [2/3] RUN echo compiling widget && echo second line\n#1 compiling widget\n#1 second line\n',
    onExport: () => gate.promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const before = new Date();

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
    buildMockCaller(),
    toApiImage,
  );

  // The stub builder writes the whole log as its build exits, so the run is caught while its
  // export is held.
  const running = await waitFor(async () => {
    const [build] = await harness.client.images.builds();

    invariant(build?.phase === 'unpack');

    return build;
  });

  gate.resolve();

  const text = await response.text();
  const after = await harness.client.images.builds();

  const events = text
    .trim()
    .split('\n')
    .map((line) => ImageBuildEventSchema.parse(JSON.parse(line)));

  expect(running).toStrictEqual({
    name: 'web',
    source: 'upload',
    startedAt: expect.toBeBetween(before, new Date()),
    phase: 'unpack',
    step: '[2/3] RUN echo compiling widget && echo second line',
    builder: expect.toStartWith('imp-build-'),
  });

  expect(events).toIncludeAllMembers([
    { type: 'log', text: '#1 [2/3] RUN echo compiling widget && echo second line' },
    { type: 'log', text: '#1 compiling widget' },
    { type: 'log', text: '#1 second line' },
    {
      type: 'progress',
      phase: 'unpack',
      elapsedMs: expect.any(Number) as unknown,
      step: '[2/3] RUN echo compiling widget && echo second line',
    },
  ]);

  expect(after).toStrictEqual([]);
});

test('it sends a progress line through the proxy before the upload ends', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const apiPort = Number(new URL(harness.url).port);

  const proxy = startWakeProxy({
    config: { ...harness.config, apiPort },
    db: harness.db,
    imps: harness.impd.imps,
    log: () => {},
    peers: createForwardedPeers(Date.now),
  });

  ctx.stack.defer(() => proxy.stop());

  const apex = proxy.startListener({
    port: 0,
    hostname: '127.0.0.1',
    route: () => ({ kind: 'api' }),
  });

  ctx.stack.defer(() => apex.stop(true));

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const rest = Promise.withResolvers<void>();
  const upload = { ended: false };

  const body = new ReadableStream<Uint8Array>({
    start: async (controller) => {
      controller.enqueue(tar.subarray(0, 512));

      await rest.promise;

      controller.enqueue(tar.subarray(512));

      upload.ended = true;

      controller.close();
    },
  });

  const response = await fetch(
    `http://127.0.0.1:${String(apex.port)}${IMAGE_BUILD_PATH}?name=web`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}`, accept: IMAGE_BUILD_STREAM_TYPE },
      body,
      duplex: 'half',
    },
  );

  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

  const firstChunk = await reader?.read();

  const endedAtFirstLine = upload.ended;

  rest.resolve();

  const parts = [firstChunk?.value ?? ''];

  for (let chunk = await reader?.read(); chunk?.done === false; chunk = await reader?.read()) {
    parts.push(chunk.value);
  }

  const lines = parts.join('').trim().split('\n');
  const first = ImageBuildEventSchema.parse(JSON.parse(lines[0] ?? 'null'));
  const last = ImageBuildEventSchema.parse(JSON.parse(lines.at(-1) ?? 'null'));

  expect(endedAtFirstLine).toBe(false);
  expect(first).toMatchObject({ type: 'progress', phase: 'upload' });
  expect(last).toMatchObject({ type: 'image', image: { name: 'web' } });
});

test('it refuses a build to a manage token limited to some imps, and audits it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const made = await harness.client.tokens.create({
    name: 'limited',
    scope: 'manage',
    imps: ['dev-*'],
  });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it refuses a build to a read token, and audits it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const made = await harness.client.tokens.create({ name: 'reader', scope: 'read' });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it answers 401 to a build with a bearer that is no token', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: 'Bearer not-a-token' },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(401);
  expect(builder.guest.runs).toStrictEqual([]);
});

test.each([
  ['name=Bad Name'],
  ['name=web&dockerfile=../Dockerfile'],
  ['name=web&dockerfile=sub/../../Dockerfile'],
  ['name=web&dockerfile=/etc/passwd'],
  [''],
])('it refuses the query %p with 400 before the upload', async (query) => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(400);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it refuses with 413 a context whose Content-Length is over the limit', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 413,
    body: {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
    },
  });
});

test('it frees the build slot of a context refused for its Content-Length', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await route.respond(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
        method: 'POST',
        headers: { 'content-length': String(2 * 1024 ** 2) },
        body: 'x',
      }),
      buildMockCaller(),
      toApiImage,
    );
  }

  const fifth = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  expect(fifth.status).toBe(413);
});

test('it refuses with 413 a context whose bytes run over the limit, and removes the upload', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(1024 ** 2 + 1)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(response.status).toBe(413);

  expect(body).toStrictEqual({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
  });

  expect(uploads).toStrictEqual([]);
});

test('it refuses with 413 a streamed build whose Content-Length is over the limit', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE, 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
    toApiImage,
  );

  expect(response.status).toBe(413);
});

test('it ends a streamed build whose bytes run over the limit with a too-large error', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(1024 ** 2 + 1)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { accept: IMAGE_BUILD_STREAM_TYPE },
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const text = await response.text();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  const last = ImageBuildEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? 'null'));

  expect(response.status).toBe(200);

  expect(last).toStrictEqual({
    type: 'error',
    code: 'PAYLOAD_TOO_LARGE',
    message: 'the build context is larger than the limit, 1 MiB (IMP_BUILD_CONTEXT_MAX_MIB)',
  });

  expect(uploads).toStrictEqual([]);
});

test('it hands a context of exactly the limit to the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(1024 ** 2)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'there is no Dockerfile in the build context' },
  });
});

test('it refuses a build with no body', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, { method: 'POST' }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is missing: send a tar' },
  });
});

test('it refuses a build whose body is longer than its Content-Length', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const context = new Blob([new Uint8Array(64)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': '4' },
      body: context,
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the body is longer than its Content-Length' },
  });
});

test('it refuses a build whose body is empty', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  const response = await route.respond(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      body: new ReadableStream({
        start: (controller) => {
          controller.close();
        },
      }),
    }),
    buildMockCaller(),
    toApiImage,
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is empty: send a tar' },
  });
});

test('it refuses a fifth build with 429 while four run', async () => {
  const ctx = await setupTest();

  const held = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await held.promise;

      return { code: 1, stderr: 'held for the test\n' };
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const running = [1, 2, 3, 4].map((index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}` },
        body: tar,
      }),
    ),
  );

  ctx.stack.defer(async () => {
    held.resolve();

    await Promise.allSettled(running);
  });

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  const fifth = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  expect(fifth.status).toBe(429);
});

test('it refuses a fifth streamed build with 429, before its stream, while four run', async () => {
  const ctx = await setupTest();

  const held = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await held.promise;

      return { code: 1, stderr: 'held for the test\n' };
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const running = [1, 2, 3, 4].map((index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}` },
        body: tar,
      }),
    ),
  );

  ctx.stack.defer(async () => {
    held.resolve();

    await Promise.allSettled(running);
  });

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  const fifth = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}`, accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  expect(fifth.status).toBe(429);
});

test('it frees each build slot once its build ends', async () => {
  const ctx = await setupTest();

  const gate = Promise.withResolvers<void>();

  const builder = buildStubImageBuilder({
    exported: [createFilesTar(ctx.directoryPath, { hello: 'hi' })],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: async () => {
      await gate.promise;

      return { stderr: '#1 DONE\n' };
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const running = [1, 2, 3, 4].map((index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}` },
        body: tar,
      }),
    ),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  gate.resolve();

  const responses = await Promise.all(running);

  invariant(responses.every((built) => built.status === 200));

  const fifth = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  expect(fifth.status).toBe(200);
});

test.each([
  ['JSON', {}],
  ['a stream', { accept: IMAGE_BUILD_STREAM_TYPE }],
])(
  "it stops the builder's build of a client that goes, answered as %s, and removes its upload",
  async (_, headers) => {
    const ctx = await setupTest();

    const builder = buildStubImageBuilder({
      exported: [],
      repoDigest: `sha256:${'b'.repeat(64)}`,
      onBuild: () => Promise.withResolvers<StubAnswer>().promise,
    });

    const harness = await startBuilderImpd(ctx.stack, builder, {
      dataDir: ctx.dataDir,
      rootToken: ctx.rootToken,
      cloneDisk: ctx.cloneDisk,
    });

    await mkdir(join(ctx.directoryPath, 'context'));
    await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

    const tar = Bun.spawnSync([
      'tar',
      '-C',
      join(ctx.directoryPath, 'context'),
      '-c',
      'Dockerfile',
    ]).stdout;

    const clients = [1, 2, 3, 4].map(() => new AbortController());

    const sent = clients.map((client, index) =>
      harness.impd.api.app.handle(
        new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=gone${String(index)}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ctx.rootToken}`, ...headers },
          body: tar,
          signal: client.signal,
        }),
      ),
    );

    await waitFor(() => {
      expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
    });

    for (const client of clients) {
      client.abort();
    }

    await Promise.allSettled(sent);

    const stopped = await waitFor(async () => {
      const rows = await listApiCalls(harness.db, null, 100, null);

      expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(
        4,
      );

      const closed = builder.guest.runs.filter((run) => run.argv[1] === 'build' && run.closed);

      expect(closed.length).toBeGreaterThanOrEqual(4);

      return closed.length;
    });

    const uploads = await readdir(buildUploadsDir(ctx.dataDir));

    expect(stopped).toBe(4);
    expect(uploads).toStrictEqual([]);
  },
);

test.each([
  ['JSON', {}],
  ['a stream', { accept: IMAGE_BUILD_STREAM_TYPE }],
])('it frees the build slot of a client that goes, answered as %s', async (_, headers) => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    onBuild: () => Promise.withResolvers<StubAnswer>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=gone${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}`, ...headers },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await Promise.allSettled(sent);

  await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  const next = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'not a tar',
    }),
  );

  expect(next.status).toBe(400);
});

test('it kills the base image pulls of clients that go, and starts no other pull', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'first.test/a:1': {
        Id: `sha256:${'a'.repeat(64)}`,
        RepoDigests: [`first.test/a@sha256:${'a'.repeat(64)}`],
        isOnEngine: false,
      },
      'second.test/b:1': {
        Id: `sha256:${'b'.repeat(64)}`,
        RepoDigests: [`second.test/b@sha256:${'b'.repeat(64)}`],
        isOnEngine: false,
      },
    },
    onPull: () => Promise.withResolvers<StubAnswer>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM first.test/a:1\nFROM second.test/b:1\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=pull${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}` },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'pull')).toHaveLength(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  await Promise.allSettled(sent);

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  const pulls = builder.guest.runs.filter((run) => run.argv[1] === 'pull');

  expect(pulls.map((run) => run.argv.slice(1).join(' '))).toStrictEqual([
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
    'pull --quiet first.test/a:1',
  ]);

  expect(pulls.map((run) => run.closed)).toStrictEqual([true, true, true, true]);
  expect(uploads).toStrictEqual([]);
});

test('it frees the build slots of clients that go during a base image pull', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'first.test/a:1': {
        Id: `sha256:${'a'.repeat(64)}`,
        RepoDigests: [`first.test/a@sha256:${'a'.repeat(64)}`],
        isOnEngine: false,
      },
    },
    onPull: () => Promise.withResolvers<StubAnswer>().promise,
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM first.test/a:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    harness.impd.api.app.handle(
      new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=pull${String(index)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.rootToken}` },
        body: tar,
        signal: client.signal,
      }),
    ),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'pull')).toHaveLength(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    expect(rows.filter((row) => row.procedure === 'images.build').length).toBeGreaterThanOrEqual(4);
  });

  await Promise.allSettled(sent);

  const next = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'not a tar',
    }),
  );

  expect(next.status).toBe(400);
});

test('it refuses a base image with ONBUILD triggers once the builder has it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/onbuild:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
        OnBuild: ['RUN id'],
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM base.test/onbuild:1\nRUN true\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(response.status).toBe(400);

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(calls).toStrictEqual([
    'info --format {{.ServerVersion}}',
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/onbuild:1',
  ]);

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it pulls COPY --from and RUN --mount images first, like a FROM, by tag or digest', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [
          `other.test/x@sha256:${'b'.repeat(64)}`,
          `base.test/a@sha256:${'a'.repeat(64)}`,
        ],
      },
      [`tools.test/b@sha256:${'b'.repeat(64)}`]: {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`tools.test/b@sha256:${'b'.repeat(64)}`],
        isOnEngine: false,
      },
      'mnt.test/c:3': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [],
        isOnEngine: false,
        pullError: 'no such registry',
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    `FROM base.test/a:1 AS build\nCOPY --from=tools.test/b@sha256:${'b'.repeat(64)} /x /x\nCOPY --from=build /x /y\nRUN --mount=type=bind,from=mnt.test/c:3,target=/m true`,
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'RUN --mount from mnt.test/c:3: the pull failed: no such registry',
  });

  expect(calls).toStrictEqual([
    'info --format {{.ServerVersion}}',
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
    'image inspect --format PIN base.test/a:1',
    `image inspect --format PIN tools.test/b@sha256:${'b'.repeat(64)}`,
    `pull --quiet tools.test/b@sha256:${'b'.repeat(64)}`,
    `image inspect --format PIN tools.test/b@sha256:${'b'.repeat(64)}`,
    'image inspect --format PIN mnt.test/c:3',
    'pull --quiet mnt.test/c:3',
  ]);
});

test('it sends the builder the Dockerfile with each image pinned and the platform named', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [
          `other.test/x@sha256:${'b'.repeat(64)}`,
          `base.test/a@sha256:${'a'.repeat(64)}`,
        ],
      },
      'pulled.test/p:2': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`tools.test/b@sha256:${'b'.repeat(64)}`],
        isOnEngine: false,
      },
      'base.test/retag:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`other.test/x@sha256:${'b'.repeat(64)}`],
      },
    },
    onBuild: () => ({ code: 1, stderr: 'the stub builder builds nothing\n' }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM --platform=$BUILDPLATFORM base.test/a:1 AS build\nCOPY --from=pulled.test/p:2 /x /x\nFROM base.test/retag:1\nRUN --mount=from=build,target=/b --mount=from=base.test/a:1,target=/a true\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'docker build failed:\nthe stub builder builds nothing',
  });

  expect(builder.builtDockerfiles).toStrictEqual([
    [
      `FROM --platform=linux/amd64 base.test/a@sha256:${'a'.repeat(64)} AS build`,
      `COPY --from=tools.test/b@sha256:${'b'.repeat(64)} /x /x`,
      `FROM other.test/x@sha256:${'b'.repeat(64)}`,
      `RUN --mount=from=build,target=/b --mount=from=base.test/a@sha256:${'a'.repeat(64)},target=/a true`,
      '',
    ].join('\n'),
  ]);
});

test('it refuses a COPY --from image with ONBUILD triggers, which the frontend would run', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/onbuild:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
        OnBuild: ['RUN id'],
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM scratch\nCOPY --from=base.test/onbuild:1 / /\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'COPY --from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses a RUN --mount image with ONBUILD triggers, which the frontend would run', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [
          `other.test/x@sha256:${'b'.repeat(64)}`,
          `base.test/a@sha256:${'a'.repeat(64)}`,
        ],
      },
      'base.test/onbuild:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/onbuild@sha256:${'a'.repeat(64)}`],
        OnBuild: ['RUN id'],
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM base.test/a:1\nRUN --mount=from=base.test/onbuild:1,target=/m true\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'RUN --mount from base.test/onbuild:1 has ONBUILD triggers, which impd refuses',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it inspects and pins a ref the build names twice once, so a moving tag gives one image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/moving:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/moving@sha256:${'a'.repeat(64)}`],
      },
    },
    onBuild: () => ({ code: 1, stderr: 'the stub builder builds nothing\n' }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM base.test/moving:1\nCOPY --from=base.test/moving:1 /x /x\nRUN --mount=from=base.test/moving:1,target=/m true\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(calls.filter((call) => call.startsWith('image inspect --format PIN'))).toStrictEqual([
    'image inspect --format PIN base.test/moving:1',
  ]);

  expect(builder.builtDockerfiles).toStrictEqual([
    [
      `FROM base.test/moving@sha256:${'a'.repeat(64)}`,
      `COPY --from=base.test/moving@sha256:${'a'.repeat(64)} /x /x`,
      `RUN --mount=from=base.test/moving@sha256:${'a'.repeat(64)},target=/m true`,
      '',
    ].join('\n'),
  ]);
});

test('it inspects and pins the spellings of one image once', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'moving:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`moving@sha256:${'a'.repeat(64)}`],
      },
      'docker.io/library/moving:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`moving@sha256:${'d'.repeat(64)}`],
      },
      'index.docker.io/library/moving': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`moving@sha256:${'b'.repeat(64)}`],
      },
    },
    onBuild: () => ({ code: 1, stderr: 'the stub builder builds nothing\n' }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM moving:1\nCOPY --from=docker.io/library/moving:1 /x /x\nRUN --mount=from=index.docker.io/library/moving,target=/m true\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(calls.filter((call) => call.startsWith('image inspect --format PIN'))).toStrictEqual([
    'image inspect --format PIN moving:1',
    'image inspect --format PIN index.docker.io/library/moving',
  ]);

  expect(builder.builtDockerfiles).toStrictEqual([
    [
      `FROM moving@sha256:${'a'.repeat(64)}`,
      `COPY --from=moving@sha256:${'a'.repeat(64)} /x /x`,
      `RUN --mount=from=moving@sha256:${'b'.repeat(64)},target=/m true`,
      '',
    ].join('\n'),
  ]);
});

test('it says how impd pinned a build the registry denies, and what to build from', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/retag:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`other.test/x@sha256:${'b'.repeat(64)}`],
      },
    },
    onBuild: () => ({
      code: 1,
      stderr: 'pull access denied, repository does not exist or may require authorization\n',
    }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/retag:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: `docker build failed:\npull access denied, repository does not exist or may require authorization\nimpd pinned FROM base.test/retag:1 as other.test/x@sha256:${'b'.repeat(64)}. On the containerd image store a retag of a multi-platform image cannot be pinned: build FROM its original repository, such as busybox:1.37, instead of the retag.`,
  });
});

test('it refuses a FROM image with no registry digest before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: { 'base.test/local:1': { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [] } },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/local:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'FROM base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; build FROM a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses a COPY --from image with no registry digest before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: { 'base.test/local:1': { Id: `sha256:${'c'.repeat(64)}`, RepoDigests: [] } },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM scratch\nCOPY --from=base.test/local:1 / /\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message:
      'COPY --from base.test/local:1: this image exists only on this host and has no registry digest, so impd cannot bind the build to it; name a registry image by tag or digest. Local base images are not supported yet (#156).',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses an arm64 image on an amd64 host before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/arm:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/arm@sha256:${'a'.repeat(64)}`],
        Architecture: 'aarch64',
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/arm:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM base.test/arm:1 is for linux/arm64, and the builder builds for linux/amd64',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses a 32-bit arm image on an amd64 host before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/arm32:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/arm32@sha256:${'a'.repeat(64)}`],
        Architecture: 'arm',
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/arm32:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM base.test/arm32:1 is for linux/arm, and the builder builds for linux/amd64',
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses an image whose registry digests name only registries impd refuses', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/private:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [
          `localhost:5000/x@sha256:${'a'.repeat(64)}`,
          `10.0.0.5:5000/y@sha256:${'b'.repeat(64)}`,
        ],
      },
    },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/private:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: `FROM base.test/private:1: its registry digests name only registries impd refuses: localhost:5000/x@sha256:${'a'.repeat(64)}, 10.0.0.5:5000/y@sha256:${'b'.repeat(64)}`,
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses an image under an IP address registry before any call on it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM 127.0.0.1:5000/x:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: 'FROM 127.0.0.1:5000/x:1: registry 127.0.0.1:5000 is an IP address',
  });

  expect(calls).toStrictEqual([
    'info --format {{.ServerVersion}}',
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
  ]);

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

// Docker reads the label as localhost in any case.
test("it refuses an image under the host's own registry, in any case, before any call on it", async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM LocalHost/name:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: "FROM LocalHost/name:1: registry LocalHost is the host's own",
  });

  expect(calls).toStrictEqual([
    'info --format {{.ServerVersion}}',
    'version --format {{json .Server.Os}} {{json .Server.Arch}}',
  ]);

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it refuses a global ARG that sets the build platform before any call', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM base.test/a:1\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('line 1: ARG BUILDPLATFORM is refused') as unknown,
  });

  expect(builder.guest.runs).toStrictEqual([]);
});

test('it refuses a stage ARG that sets the target platform before any call', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    'FROM base.test/a:1\nARG TARGETPLATFORM\n',
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining('line 2: ARG TARGETPLATFORM is refused') as unknown,
  });

  expect(builder.guest.runs).toStrictEqual([]);
});

test('it refuses a braced platform variable before any call', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));

  await writeFile(
    join(ctx.directoryPath, 'context', 'Dockerfile'),
    ['FROM --platform=$', '{BUILDPLATFORM} base.test/a:1\n'].join(''),
  );

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(body).toStrictEqual({
    code: 'BAD_REQUEST',
    message: expect.stringContaining(
      ['FROM --platform=$', '{BUILDPLATFORM} is refused'].join(''),
    ) as unknown,
  });

  expect(builder.guest.runs).toStrictEqual([]);
});

test('it pulls a missing Dockerfile frontend by digest once, before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
      },
    },
    frontend: { isOnEngine: false },
    onBuild: () => ({ code: 1, stderr: 'the stub builder builds nothing\n' }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(calls.filter((call) => call.includes(DOCKERFILE_FRONTEND))).toStrictEqual([
    `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
    `pull --quiet ${DOCKERFILE_FRONTEND}`,
    `build --progress=plain --build-arg BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND} --tag imp-build:latest --file Dockerfile -`,
  ]);
});

test('it pulls no Dockerfile frontend the builder has, and checks it before the build', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
      },
    },
    frontend: { isOnEngine: true },
    onBuild: () => ({ code: 1, stderr: 'the stub builder builds nothing\n' }),
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(calls.filter((call) => call.includes(DOCKERFILE_FRONTEND))).toStrictEqual([
    `image inspect --format {{.Id}} ${DOCKERFILE_FRONTEND}`,
    `build --progress=plain --build-arg BUILDKIT_SYNTAX=${DOCKERFILE_FRONTEND} --tag imp-build:latest --file Dockerfile -`,
  ]);

  expect(calls.filter((call) => call.startsWith('pull'))).toStrictEqual([]);
});

test('it fails a build with 502 before the builder builds it when the frontend pull fails', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    images: {
      'base.test/a:1': {
        Id: `sha256:${'c'.repeat(64)}`,
        RepoDigests: [`base.test/a@sha256:${'a'.repeat(64)}`],
      },
    },
    frontend: { isOnEngine: false, pullError: 'no route to host' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM base.test/a:1\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();

  expect(response.status).toBe(502);

  expect(body).toStrictEqual({
    code: 'BAD_GATEWAY',
    message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: no route to host`,
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it answers a build that fails after the builder built it with its error, and removes the upload', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { create: 'no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const body: unknown = await response.json();
  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(response.status).toBe(500);

  expect(body).toStrictEqual({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'docker create in the builder: no space left on device',
  });

  expect(uploads).toStrictEqual([]);
});

test('it ends a streamed build that fails with its error, and removes the upload', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { create: 'no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}`, accept: IMAGE_BUILD_STREAM_TYPE },
      body: tar,
    }),
  );

  const text = await response.text();

  const last = ImageBuildEventSchema.parse(JSON.parse(text.trim().split('\n').at(-1) ?? 'null'));

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(last).toStrictEqual({
    type: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'docker create in the builder: no space left on device',
  });

  expect(uploads).toStrictEqual([]);
});

test('it audits a failed build with its code', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { create: 'no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const tar = Bun.spawnSync([
    'tar',
    '-C',
    join(ctx.directoryPath, 'context'),
    '-c',
    'Dockerfile',
  ]).stdout;

  await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.build');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(outcomes).toStrictEqual(['INTERNAL_SERVER_ERROR']);
});

test('it clears what an earlier impd left in the uploads directory when a route starts', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const leftover = join(buildUploadsDir(ctx.dataDir), 'old.tar');

  await writeFile(leftover, 'half a context');

  createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    keepaliveMs: 10_000,
  });

  expect(existsSync(leftover)).toBeFalse();
});

test('it reports the unpack of an on-host build after the builder built the image', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    failures: { create: 'Error response from daemon: no space left on device' },
  });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  await mkdir(join(ctx.directoryPath, 'context'));
  await writeFile(join(ctx.directoryPath, 'context', 'Dockerfile'), 'FROM scratch\n');

  const phases: string[] = [];

  const building = harness.impd.images.runImageBuild(
    join(ctx.directoryPath, 'context'),
    'web',
    undefined,
    {
      setPhase: (phase) => {
        phases.push(phase);
      },
    },
  );

  expect(building).rejects.toThrowWithMessage(
    Error,
    /Error response from daemon: no space left on device/u,
  );

  expect(phases).toStrictEqual(['build', 'unpack']);
});

test('it refuses an on-host build at once while uploads hold all four build slots', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const held = [1, 2, 3, 4].map(() => harness.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held) {
      release();
    }
  });

  const building = harness.impd.images.runImageBuild('relative/path', 'web');

  expect(building).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
});

test('it refuses an upload with 429 while on-host builds hold all four build slots', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const held = [1, 2, 3, 4].map(() => harness.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held) {
      release();
    }
  });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${IMAGE_BUILD_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'tar',
    }),
  );

  expect(response.status).toBe(429);
});

test('it lets an on-host build through to its own checks once a build slot is free', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const held = [1, 2, 3, 4].map(() => harness.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of held.slice(1)) {
      release();
    }
  });

  held[0]?.();
  const building = harness.impd.images.runImageBuild('relative/path', 'web');

  expect(building).rejects.toMatchObject({ code: 'BAD_REQUEST' });
});
