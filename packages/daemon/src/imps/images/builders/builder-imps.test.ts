import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../../../testing/imps/build-mock-new-image';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../../../../testing/imps/build-stub-image-builder';
import { createBuilderImage } from '../../../../testing/imps/create-builder-image';
import { makeStubEngineAnswer } from '../../../../testing/imps/make-stub-engine-answer';
import { buildStubClock } from '../../../../testing/platform/build-stub-clock';
import { captureImpdLogs } from '../../../../testing/platform/capture-impd-logs';
import { startTestImpd } from '../../../../testing/start-test-impd';
import { buildStubGuest } from '../../../../testing/vm/build-stub-guest';
import { makeStubCommandAnswer } from '../../../../testing/vm/make-stub-command-answer';
import { createImage } from '../../../platform/db/images';
import { listImps, readImpByName } from '../../../platform/db/imps';
import { countTreeBytes } from '../../../vm/storage/count-tree-bytes';
import { buildImagePaths } from '../../../vm/storage/data-layout';
import { writeGuestTree } from '../build/guest-build';
import { startTarProcess } from '../rootfs/start-tar-process';
import { createBuilders } from './builder-imps';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  return startTestImpd(stack);
}

test('it gives a build a public builder of the build size', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: { build: { ...ctx.config.build, memoryMib: 512, diskBytes: 4 * 1024 ** 3 } },
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const builder = await builders.withBuilder(new AbortController().signal, async () => {
    const imps = await listImps(ctx.db);

    return imps.find((imp) => imp.kind === 'builder');
  });

  expect(builder).toMatchObject({
    kind: 'builder',
    name: expect.stringMatching(/^imp-build-[a-km-np-z2-9]{8}$/v) as unknown,
    memoryMib: 512,
    diskBytes: 4 * 1024 ** 3,
  });
});

test('it holds the public egress policy for the builder while the build runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const policy = await builders.withBuilder(new AbortController().signal, async () => {
    const [builder] = await listImps(ctx.db);

    invariant(builder);

    return ctx.impd.egress.readPolicy(builder.name);
  });

  expect(policy).toStrictEqual({ mode: 'public', allow: [] });
});

test('it removes the builder and its egress policy when the build ends', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const name = await builders.withBuilder(new AbortController().signal, async () => {
    const [builder] = await listImps(ctx.db);

    invariant(builder);

    return builder.name;
  });

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);

  expect(ctx.impd.egress.readPolicy(name)).rejects.toMatchObject({
    code: 'NOT_FOUND',
    message: `imp ${name} not found`,
  });
});

test('it adds the builder image before the builder starts', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const ensured: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      const builderImage = await createBuilderImage({
        db: ctx.db,
        dataDir: ctx.dataDir,
        ref: ctx.config.build.image,
      });

      ensured.push(builderImage.name);
    },
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  expect(ensured).toStrictEqual(['imp-builder']);
});

test('it asks the builder engine again, a poll later, until it answers, then runs the build', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(makeStubEngineAnswer({ refusals: 1, answer: { stdout: 'ok' } }));
  const clock = buildStubClock();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    clock,
  });

  const ran = await builders.withBuilder(new AbortController().signal, async (exec) => {
    const answered = await exec(['echo'], { signal: new AbortController().signal });

    return answered.stdout;
  });

  expect(ran).toBe('ok');
  expect(clock.sleeps).toStrictEqual([500]);

  expect(guest.runs.map((run) => run.argv.join(' '))).toStrictEqual([
    'docker info --format {{.ServerVersion}}',
    'docker info --format {{.ServerVersion}}',
    'echo',
  ]);
});

test('it logs the time its builder took to answer, on its clock', async () => {
  const ctx = await setupTest();

  const logs = captureImpdLogs();
  const guest = buildStubGuest(makeStubEngineAnswer({ refusals: 1, answer: { stdout: 'ok' } }));
  const clock = buildStubClock();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    clock,
    pickBuilderName: () => 'imp-build-timed',
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  expect(logs).toContain(
    'INFO impd.image imp=imp-build-timed image build: the builder is ready in 500ms',
  );
});

test('it names each builder with its name picker', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    pickBuilderName: () => 'imp-build-picked',
  });

  const name = await builders.withBuilder(new AbortController().signal, (_exec, builder) =>
    Promise.resolve(builder),
  );

  expect(name).toBe('imp-build-picked');
});

test('it writes the test registry into the builder, once its engine answers and before the build runs', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    testRegistry: {
      name: 'registry.example.test',
      address: '10.200.0.1',
      port: 5443,
      readCA: () =>
        Promise.resolve('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'),
    },
  });

  await builders.withBuilder(new AbortController().signal, (exec) =>
    exec(['echo'], { signal: new AbortController().signal }),
  );

  expect(guest.runs.map((run) => run.argv)).toStrictEqual([
    ['docker', 'info', '--format', '{{.ServerVersion}}'],
    [
      'sh',
      '-c',
      [
        'set -e',
        'mkdir -p "/etc/docker/certs.d/$1:$2"',
        'printf "%s" "$3" > "/etc/docker/certs.d/$1:$2/ca.crt"',
        String.raw`printf "%s %s\n" "$4" "$1" >> /etc/hosts`,
      ].join('\n'),
      'sh',
      'registry.example.test',
      '5443',
      '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
      '10.200.0.1',
    ],
    ['echo'],
  ]);
});

test('it fails the build when the builder refuses the test registry, and removes the builder', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(
    makeStubCommandAnswer({ sh: { code: 1, stderr: 'sh: read-only file system' } }, {}),
  );

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    testRegistry: {
      name: 'registry.example.test',
      address: '10.200.0.1',
      port: 5443,
      readCA: () =>
        Promise.resolve('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n'),
    },
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  const failure = await building.then(
    () => null,
    (error: unknown) => error,
  );

  const imps = await listImps(ctx.db);

  expect(failure).toStrictEqual(
    new Error(
      'writing the test registry registry.example.test into the builder: sh: read-only file system',
    ),
  );

  expect(imps).toStrictEqual([]);
});

test('it fails the build when the builder engine does not answer in 60 s, and removes the builder', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));
  const clock = buildStubClock();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    clock,
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toThrowWithMessage(
    Error,
    "the builder's engine did not answer in 60 s: Cannot connect to the Docker daemon",
  );

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test("it gives the tail of the builder engine's log when the engine does not answer in 60 s", async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(
    makeStubCommandAnswer(
      { tail: { stdout: 'level=info msg="Starting up"\nlevel=fatal msg="no overlay support"\n' } },
      { code: 1, stderr: 'Cannot connect to the Docker daemon' },
    ),
  );

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    clock: buildStubClock(),
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toThrowWithMessage(
    Error,
    [
      "the builder's engine did not answer in 60 s: Cannot connect to the Docker daemon",
      'the last lines of /var/log/imp/docker.log:',
      'level=info msg="Starting up"',
      'level=fatal msg="no overlay support"',
    ].join('\n'),
  );
});

test('it removes the builder of a failed build and rethrows the build error', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.reject(new Error('the build failed')),
  );

  expect(building).rejects.toThrowWithMessage(Error, 'the build failed');

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it removes the builders a stopped impd left, and never a user imp', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
  });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });
  await ctx.impd.imps.createImp({ name: 'dev', image: 'base' });
  await builders.removeLeftovers();

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.name)).toStrictEqual(['dev']);
});

test('it keeps the build of a builder that survives its removal, and logs the survivor', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs = captureImpdLogs();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    startTimer: timers.startTimer,
    pickBuilderName: () => 'imp-build-survivor',
  });

  ctx.fake.queue('stop', 'fail');

  const built = await builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  const survivors = await listImps(ctx.db);

  expect(built).toBe('built');
  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);
  expect(timers.readPendingMs()).toStrictEqual([30_000]);

  expect(logs).toContainEqual(
    expect.stringMatching(
      /^ERROR impd\.image imp=imp-build-survivor image build: the builder survives its removal, tried again every 30 s: firecracker \d+ survived SIGKILL$/v,
    ),
  );
});

test('it removes a builder that survived its removal on a later retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs = captureImpdLogs();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    startTimer: timers.startTimer,
    pickBuilderName: () => 'imp-build-survivor',
  });

  ctx.fake.queue('stop', 'fail');

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  const survivors = await listImps(ctx.db);

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain(
      'INFO impd.image imp=imp-build-survivor image build: removed the builder',
    );
  });

  const imps = await listImps(ctx.db);

  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);
  expect(imps).toStrictEqual([]);
});

test('it retries the removal of a leftover builder that survives it at start', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs = captureImpdLogs();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    startTimer: timers.startTimer,
  });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });

  ctx.fake.queue('stop', 'fail', 'fail');

  await builders.removeLeftovers();

  timers.firePending();

  await waitFor(() => {
    expect(timers.readPendingMs()).toStrictEqual([30_000]);
  });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('INFO impd.image imp=imp-build-left image build: removed the builder');
  });

  const imps = await listImps(ctx.db);

  const errors = logs.filter((line) =>
    line.startsWith('ERROR impd.image imp=imp-build-left image build: the builder survives'),
  );

  expect(imps).toStrictEqual([]);
  expect(errors).toHaveLength(2);
});

test('it never removes a user imp that took the id of a removed builder on a retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs = captureImpdLogs();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    startTimer: timers.startTimer,
  });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  const builder = await ctx.impd.imps.createImp({
    name: 'imp-build-left',
    image: 'base',
    kind: 'builder',
  });

  const record = await readImpByName(ctx.db, builder.name);

  invariant(record);

  const id = record.id;

  ctx.fake.queue('stop', 'fail');

  await builders.removeLeftovers();
  await ctx.impd.imps.destroyImpId(id);
  await ctx.impd.imps.createImp({ id, name: 'mine', image: 'base' });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('INFO impd.image imp=imp-build-left image build: removed the builder');
  });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.id, imp.name, imp.kind])).toStrictEqual([[id, 'mine', 'user']]);
});

test('it ends an export over its file limit and removes its builder, with no client cancel', async () => {
  const ctx = await setupTest();
  const tree = await mkdtemp(join(tmpdir(), 'builder-stall-'));

  onTestFinished(() => rm(tree, { recursive: true, force: true }));

  const parents = Array.from({ length: 20 }, (_, index) => `d${String(index)}`).join('/');

  await mkdir(join(tree, 'tree', parents), { recursive: true });
  await writeFile(join(tree, 'tree', parents, 'f'), 'x');
  await mkdir(join(tree, 'root'));

  const deep = Bun.spawnSync([
    'tar',
    '-C',
    join(tree, 'tree'),
    '--no-recursion',
    '-c',
    `${parents}/f`,
  ]);

  const engine = buildStubImageBuilder({
    exported: [deep.stdout],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => engine.guest.open(request),
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree({
      exec,
      root: join(tree, 'root'),
      limits: { maxBytes: 1024 ** 3, maxFiles: 1 },
      signal: new AbortController().signal,
      startTar: startTarProcess,
      countTreeBytes,
    }),
  );

  expect(exporting).rejects.toThrowWithMessage(
    Error,
    "the built image's filesystem is over 1 files (IMP_BUILD_IMAGE_MAX_FILES)",
  );

  const imps = await listImps(ctx.db);

  expect(imps).toStrictEqual([]);
});

test('it ends an export stopped while its exec opens, closes the exec and removes its builder', async () => {
  const ctx = await setupTest();
  const tree = await mkdtemp(join(tmpdir(), 'builder-open-'));

  onTestFinished(() => rm(tree, { recursive: true, force: true }));

  await mkdir(join(tree, 'root'));

  const engine = buildStubImageBuilder({
    exported: [],
    repoDigest: `sha256:${'b'.repeat(64)}`,
    isExportStalled: true,
  });

  const timers = buildStubClock();
  const exportOpen = Promise.withResolvers<void>();
  const reached = { isExportOpening: false };

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: async (_name, request) => {
        if (request.argv[1] === 'export') {
          reached.isExportOpening = true;

          await exportOpen.promise;
        }

        return engine.guest.open(request);
      },
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree({
      exec,
      root: join(tree, 'root'),
      limits: { maxBytes: 1024 ** 3, maxFiles: 1000 },
      signal: new AbortController().signal,
      grow: () => Promise.resolve(),
      startTimer: timers.startTimer,
      startTar: startTarProcess,
      countTreeBytes,
    }),
  );

  await waitFor(() => {
    expect(reached.isExportOpening).toBeTrue();
  });

  timers.firePending();
  exportOpen.resolve();

  expect(exporting).rejects.toThrowWithMessage(
    Error,
    'docker export in the builder sent nothing in 120 s',
  );

  const imps = await listImps(ctx.db);

  expect(engine.guest.runs.at(-1)).toMatchObject({
    argv: ['docker', 'export', STUB_BUILDER_CONTAINER],
    closed: true,
  });

  expect(imps).toStrictEqual([]);
});

test('it refuses an exec in a builder', async () => {
  const ctx = await setupTest();

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-x', image: 'base', kind: 'builder' });

  const opening = ctx.impd.imps.openExec('imp-build-x', { argv: ['sh'], tty: false });

  expect(opening).rejects.toMatchObject({
    code: 'PRECONDITION_FAILED',
    message: 'imp-build-x is an image builder that impd made for one build; only rm reaches it',
  });
});

test('it leaves the imp that holds a name a builder create fails on', async () => {
  const ctx = await setupTest();

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,

      createImp: async (input) => {
        await ctx.impd.imps.createImp({ name: input.name, image: 'base' });

        return ctx.impd.imps.createImp(input);
      },
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
  });

  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  const building = builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  expect(building).rejects.toMatchObject({ code: 'CONFLICT' });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => imp.kind)).toStrictEqual(['user']);
  expect(imps[0]?.name).toMatch(/^imp-build-[a-z2-9]{8}$/v);
});
