import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { faker } from '@faker-js/faker';
import { BUILD_CONTEXT_PATH, BuildContextUploadSchema } from '@impz/api';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockCaller } from '../../../testing/identity/build-mock-caller';
import { buildStubImageBuilder } from '../../../testing/imps/build-stub-image-builder';
import { createFilesTar } from '../../../testing/imps/create-files-tar';
import { startBuilderImpd } from '../../../testing/imps/start-builder-impd';
import { buildStubClock } from '../../../testing/platform/build-stub-clock';
import { runUploadedBuild } from '../../../testing/surface/run-uploaded-build';
import type { StubAnswer } from '../../../testing/vm/build-stub-guest';
import { DOCKERFILE_FRONTEND } from '../../imps/docker-contract/dockerfile-frontend';
import { PIN_INSPECT_FORMAT } from '../../imps/images/pull/image-pin';
import { createForwardedPeers } from '../../network/proxy/forwarded-peers';
import { startWakeProxy } from '../../network/proxy/wake-proxy';
import { createApiAudit } from '../../platform/audit/api-audit';
import { listApiCalls } from '../../platform/db/api-audit';
import { runChecked } from '../../platform/process/run-command';
import { buildUploadsDir } from '../../vm/storage/data-layout';
import { readErrorCode } from '../read-error-code';
import { UPLOAD_TTL_MS, createBuildContextRoute } from './build-context-route';

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

test('it builds an uploaded context and streams the image last', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const events = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  });

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
  expect(builder.builtDockerfiles).toStrictEqual(['FROM scratch\n']);
});

test('it builds under the name and with the Dockerfile path the upload named', async () => {
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

  const events = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=api&dockerfile=docker/Dockerfile',
    body: tar,
  });

  const builds = builder.guest.runs.filter((run) => run.argv[1] === 'build').map((run) => run.argv);

  expect(events.at(-1)).toMatchObject({ type: 'image', image: { name: 'api' } });

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

test('it removes the upload and audits the build as ok under the image name once the build ends', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar });

  const builds = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const found = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(found).not.toBeEmpty();

    return found.map((row) => ({ outcome: row.outcome, detail: row.detail }));
  });

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(builds).toStrictEqual([{ outcome: 'ok', detail: 'web' }]);
  expect(uploads).toStrictEqual([]);
});

test('it streams progress while the build runs, then the image', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const uploaded = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const answer: unknown = await uploaded.json();

  const upload = BuildContextUploadSchema.parse(answer);

  const events = await harness.buildClient(ctx.rootToken).images.buildStream({ upload: upload.id });

  // The gate holds the build, so the first event comes from a build that still runs.
  const first = await events.next();

  gate.resolve();

  const rest = await Array.fromAsync(events);

  expect(first.value).toStrictEqual({
    type: 'progress',
    phase: 'build',
    elapsedMs: expect.any(Number) as unknown,
  });

  expect(rest.at(-1)).toMatchObject({ type: 'image', image: { name: 'web' } });
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const before = new Date();

  const building = runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
    logs: true,
  });

  // The stub builder writes the whole log as its build exits, so the run is caught while its
  // export is held.
  const running = await waitFor(async () => {
    const [build] = await harness.client.images.builds();

    invariant(build?.phase === 'unpack');

    return build;
  });

  gate.resolve();

  const events = await building;
  const after = await harness.client.images.builds();

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

test('it lists an upload in images.builds in the upload phase until a build takes it', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });
  const client = harness.buildClient(ctx.rootToken);

  const before = new Date();

  const uploaded = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const answer: unknown = await uploaded.json();

  const upload = BuildContextUploadSchema.parse(answer);

  const listed = await client.images.builds();
  const built = await client.images.buildStream({ upload: upload.id });

  await Array.fromAsync(built);

  const after = await client.images.builds();

  expect(listed).toStrictEqual([
    {
      name: 'web',
      source: 'upload',
      startedAt: expect.toBeBetween(before, new Date()),
      phase: 'upload',
      step: null,
      builder: null,
    },
  ]);

  expect(after).toStrictEqual([]);
});

test('it removes an upload, frees its slot and ends its run when no build takes it in time', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const clock = buildStubClock();
  const caller = buildMockCaller();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    startTimer: clock.startTimer,
  });

  const uploaded = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, { method: 'POST', body: 'tar' }),
    caller,
  );

  const answer: unknown = await uploaded.json();

  const upload = BuildContextUploadSchema.parse(answer);

  clock.runFor(UPLOAD_TTL_MS);

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));
  const builds = await harness.client.images.builds();

  const slots = [1, 2, 3, 4].map(() => harness.impd.images.claimBuildSlot());

  onTestFinished(() => {
    for (const release of slots) {
      release();
    }
  });

  expect(uploads).toStrictEqual([]);
  expect(builds).toStrictEqual([]);
  expect(slots).toHaveLength(4);

  expect(() => route.takeUpload(upload.id, caller)).toThrow(
    `build context upload ${upload.id} not found; upload the context again`,
  );
});

test('it expires an upload on the build upload timer impd was given', async () => {
  const ctx = await setupTest();

  const clock = buildStubClock();
  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
    boundaries: { buildUploadTimer: clock.startTimer },
  });

  const uploaded = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'tar',
    }),
  );

  const before = await readdir(buildUploadsDir(ctx.dataDir));

  clock.runFor(UPLOAD_TTL_MS);

  const after = await readdir(buildUploadsDir(ctx.dataDir));

  expect(uploaded.status).toBe(201);
  expect(before).toHaveLength(1);
  expect(after).toStrictEqual([]);
});

test("it refuses another caller's upload with not found", async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const owner = buildMockCaller();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    startTimer: buildStubClock().startTimer,
  });

  const uploaded = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, { method: 'POST', body: 'tar' }),
    owner,
  );

  const answer: unknown = await uploaded.json();

  const upload = BuildContextUploadSchema.parse(answer);

  onTestFinished(() => {
    route.takeUpload(upload.id, owner).release();
  });

  expect(() => route.takeUpload(upload.id, buildMockCaller())).toThrow(
    `build context upload ${upload.id} not found; upload the context again`,
  );
});

test('it refuses an upload that a build already took with not found', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });
  const client = harness.buildClient(ctx.rootToken);

  const uploaded = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: tar,
    }),
  );

  const answer: unknown = await uploaded.json();

  const upload = BuildContextUploadSchema.parse(answer);

  const built = await client.images.buildStream({ upload: upload.id });

  await Array.fromAsync(built);

  const again = await client.images.buildStream({ upload: upload.id });

  expect(Array.fromAsync(again)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: `build context upload ${upload.id} not found; upload the context again`,
  });
});

test('it takes an upload through the proxy', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const body = new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(tar.subarray(0, 512));
      controller.enqueue(tar.subarray(512));
      controller.close();
    },
  });

  const response = await fetch(
    `http://127.0.0.1:${String(apex.port)}${BUILD_CONTEXT_PATH}?name=web`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body,
      duplex: 'half',
    },
  );

  const answer: unknown = await response.json();

  expect(response.status).toBe(201);

  const upload: unknown = BuildContextUploadSchema.parse(answer);

  expect(upload).toStrictEqual({
    id: expect.any(String) as unknown,
    expiresAt: expect.toBeValidDate(),
  });
});

test('it refuses an upload to a manage token limited to some imps, and audits it', async () => {
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
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it refuses an upload to a read token, and audits it', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const made = await harness.client.tokens.create({ name: 'reader', scope: 'read' });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}` },
      body: 'tar',
    }),
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

    expect(builds).not.toBeEmpty();

    return builds.map((row) => row.outcome);
  });

  expect(response.status).toBe(403);
  expect(outcomes).toStrictEqual(['FORBIDDEN']);
  expect(builder.guest.runs).toStrictEqual([]);
});

test('it answers 401 to an upload with a bearer that is no token', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const response = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
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
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?${query}`, {
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
    startTimer: buildStubClock().startTimer,
  });

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
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
    startTimer: buildStubClock().startTimer,
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    await route.respond(
      new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
        method: 'POST',
        headers: { 'content-length': String(2 * 1024 ** 2) },
        body: 'x',
      }),
      buildMockCaller(),
    );
  }

  const fifth = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': String(2 * 1024 ** 2) },
      body: 'x',
    }),
    buildMockCaller(),
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
    startTimer: buildStubClock().startTimer,
  });

  const context = new Blob([new Uint8Array(1024 ** 2 + 1)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    buildMockCaller(),
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

test('it takes a context of exactly the limit', async () => {
  const ctx = await setupTest();

  const builder = buildStubImageBuilder({ exported: [], repoDigest: `sha256:${'b'.repeat(64)}` });

  const harness = await startBuilderImpd(ctx.stack, builder, {
    dataDir: ctx.dataDir,
    rootToken: ctx.rootToken,
    cloneDisk: ctx.cloneDisk,
  });

  const caller = buildMockCaller();

  const route = createBuildContextRoute({
    config: { dataDir: ctx.dataDir, buildContextMaxBytes: 1024 ** 2 },
    images: harness.impd.images,
    diskBudget: harness.impd.diskBudget,
    audit: createApiAudit({ db: harness.db, now: Date.now, log: () => {}, readErrorCode }),
    now: Date.now,
    startTimer: buildStubClock().startTimer,
  });

  const context = new Blob([new Uint8Array(1024 ** 2)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      body: context,
    }),
    caller,
  );

  const answer: unknown = await response.json();

  const upload = BuildContextUploadSchema.parse(answer);

  onTestFinished(() => {
    route.takeUpload(upload.id, caller).release();
  });

  expect(response.status).toBe(201);
});

test('it refuses an upload with no body', async () => {
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
    startTimer: buildStubClock().startTimer,
  });

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, { method: 'POST' }),
    buildMockCaller(),
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is missing: send a tar' },
  });
});

test('it refuses an upload whose body is longer than its Content-Length', async () => {
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
    startTimer: buildStubClock().startTimer,
  });

  const context = new Blob([new Uint8Array(64)]).stream();

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { 'content-length': '4' },
      body: context,
    }),
    buildMockCaller(),
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the body is longer than its Content-Length' },
  });
});

test('it refuses an upload whose body is empty', async () => {
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
    startTimer: buildStubClock().startTimer,
  });

  const response = await route.respond(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      body: new ReadableStream({
        start: (controller) => {
          controller.close();
        },
      }),
    }),
    buildMockCaller(),
  );

  const body: unknown = await response.json();

  expect({ status: response.status, body }).toStrictEqual({
    status: 400,
    body: { code: 'BAD_REQUEST', message: 'the build context is empty: send a tar' },
  });
});

test('it refuses a fifth upload with 429 while four builds run', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const running = [1, 2, 3, 4].map((index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=web${String(index)}`,
      body: tar,
    }),
  );

  ctx.stack.defer(async () => {
    held.resolve();

    await Promise.allSettled(running);
  });

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  const fifth = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web5`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const running = [1, 2, 3, 4].map((index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=web${String(index)}`,
      body: tar,
    }),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'build')).toHaveLength(4);
  });

  gate.resolve();

  await Promise.all(running);

  const fifth = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web5',
    body: tar,
  });

  expect(fifth.at(-1)).toMatchObject({ type: 'image', image: { name: 'web5' } });
});

test("it stops the builder's build of a client that goes, and removes its upload", async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=gone${String(index)}`,
      body: tar,
      signal: client.signal,
    }),
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

    expect(
      rows.filter((row) => row.procedure === 'images.buildStream').length,
    ).toBeGreaterThanOrEqual(4);

    const closed = builder.guest.runs.filter((run) => run.argv[1] === 'build' && run.closed);

    expect(closed.length).toBeGreaterThanOrEqual(4);

    return closed.length;
  });

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(stopped).toBe(4);
  expect(uploads).toStrictEqual([]);
});

test('it frees the build slot of a client that goes', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=gone${String(index)}`,
      body: tar,
      signal: client.signal,
    }),
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

    expect(
      rows.filter((row) => row.procedure === 'images.buildStream').length,
    ).toBeGreaterThanOrEqual(4);
  });

  const next = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'tar',
    }),
  );

  expect(next.status).toBe(201);
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM first.test/a:1\nFROM second.test/b:1\n',
  });

  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=pull${String(index)}`,
      body: tar,
      signal: client.signal,
    }),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'pull')).toHaveLength(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await Promise.allSettled(sent);

  await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    expect(
      rows.filter((row) => row.procedure === 'images.buildStream').length,
    ).toBeGreaterThanOrEqual(4);
  });

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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM first.test/a:1\n' });
  const clients = [1, 2, 3, 4].map(() => new AbortController());

  const sent = clients.map((client, index) =>
    runUploadedBuild(harness, {
      token: ctx.rootToken,
      query: `name=pull${String(index)}`,
      body: tar,
      signal: client.signal,
    }),
  );

  await waitFor(() => {
    expect(builder.guest.runs.filter((run) => run.argv[1] === 'pull')).toHaveLength(4);
  });

  for (const client of clients) {
    client.abort();
  }

  await Promise.allSettled(sent);

  await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    expect(
      rows.filter((row) => row.procedure === 'images.buildStream').length,
    ).toBeGreaterThanOrEqual(4);
  });

  const next = await harness.impd.api.app.handle(
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ctx.rootToken}` },
      body: 'tar',
    }),
  );

  expect(next.status).toBe(201);
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM base.test/onbuild:1\nRUN true\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(failure).toMatchObject({
    code: 'BAD_REQUEST',
    status: 400,
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: `FROM base.test/a:1 AS build\nCOPY --from=tools.test/b@sha256:${'b'.repeat(64)} /x /x\nCOPY --from=build /x /y\nRUN --mount=type=bind,from=mnt.test/c:3,target=/m true`,
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const calls = builder.guest.runs.map((run) =>
    run.argv.slice(1).join(' ').replace(PIN_INSPECT_FORMAT, 'PIN'),
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile:
      'FROM --platform=$BUILDPLATFORM base.test/a:1 AS build\nCOPY --from=pulled.test/p:2 /x /x\nFROM base.test/retag:1\nRUN --mount=from=build,target=/b --mount=from=base.test/a:1,target=/a true\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM scratch\nCOPY --from=base.test/onbuild:1 / /\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM base.test/a:1\nRUN --mount=from=base.test/onbuild:1,target=/m true\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile:
      'FROM base.test/moving:1\nCOPY --from=base.test/moving:1 /x /x\nRUN --mount=from=base.test/moving:1,target=/m true\n',
  });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar }).catch(
    () => [],
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile:
      'FROM moving:1\nCOPY --from=docker.io/library/moving:1 /x /x\nRUN --mount=from=index.docker.io/library/moving,target=/m true\n',
  });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar }).catch(
    () => [],
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/retag:1\n' });

  const building = runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  });

  expect(building).rejects.toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/local:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM scratch\nCOPY --from=base.test/local:1 / /\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/arm:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/arm32:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/private:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM 127.0.0.1:5000/x:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM LocalHost/name:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const calls = builder.guest.runs.map((run) => run.argv.slice(1).join(' '));

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'ARG BUILDPLATFORM=linux/arm64\nFROM --platform=$BUILDPLATFORM base.test/a:1\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: 'FROM base.test/a:1\nARG TARGETPLATFORM\n',
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, {
    Dockerfile: ['FROM --platform=$', '{BUILDPLATFORM} base.test/a:1\n'].join(''),
  });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\n' });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar }).catch(
    () => [],
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\n' });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar }).catch(
    () => [],
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM base.test/a:1\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  expect(failure).toMatchObject({
    code: 'BAD_GATEWAY',
    status: 502,
    message: `the Dockerfile frontend ${DOCKERFILE_FRONTEND}: the pull failed: no route to host`,
  });

  expect(builder.builtDockerfiles).toStrictEqual([]);
});

test('it ends a build that fails after the builder built it with an internal error, and removes the upload', async () => {
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  const failure = await runUploadedBuild(harness, {
    token: ctx.rootToken,
    query: 'name=web',
    body: tar,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  const uploads = await readdir(buildUploadsDir(ctx.dataDir));

  expect(failure).toMatchObject({
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
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

  const tar = createFilesTar(ctx.directoryPath, { Dockerfile: 'FROM scratch\n' });

  await runUploadedBuild(harness, { token: ctx.rootToken, query: 'name=web', body: tar }).catch(
    () => [],
  );

  const outcomes = await waitFor(async () => {
    const rows = await listApiCalls(harness.db, null, 100, null);

    const builds = rows.filter((row) => row.procedure === 'images.buildStream');

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
    startTimer: buildStubClock().startTimer,
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
    new Request(`http://impd.test${BUILD_CONTEXT_PATH}?name=web`, {
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
