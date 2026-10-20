import { expect, onTestFinished, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';
import invariant from 'tiny-invariant';
import { buildMockNewImage } from '../../testing/imps/build-mock-new-image';
import {
  STUB_BUILDER_CONTAINER,
  buildStubImageBuilder,
} from '../../testing/imps/build-stub-image-builder';
import { createBuilderImage } from '../../testing/imps/create-builder-image';
import { buildStubClock } from '../../testing/platform/build-stub-clock';
import { startTestImpd } from '../../testing/start-test-impd';
import { buildStubGuest } from '../../testing/vm/build-stub-guest';
import { createImage } from '../db/images';
import { findImpByName, listImps } from '../db/imps';
import { buildImagePaths } from '../storage/data-layout';
import { createBuilders } from './builder-imps';
import { writeGuestTree } from './guest-build';

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
    log: () => {},
  });

  const builder = await builders.withBuilder(new AbortController().signal, async () => {
    const imps = await listImps(ctx.db);

    return imps.find((imp) => imp.kind === 'builder');
  });

  expect(builder).toMatchObject({
    kind: 'builder',
    name: expect.stringMatching(/^imp-build-[a-z2-9]{8}$/v) as unknown,
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
    log: () => {},
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
    log: () => {},
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
    log: () => {},
  });

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  expect(ensured).toStrictEqual(['imp-builder']);
});

test('it asks the builder engine again, a poll later, until it answers, then runs the build', async () => {
  const ctx = await setupTest();

  const infos = { count: 0 };

  // the first `docker info` finds the engine still starting
  const guest = buildStubGuest((run) => {
    if (run.argv[1] !== 'info') {
      return { stdout: 'ok' };
    }

    infos.count += 1;

    return infos.count === 1 ? { code: 1, stderr: 'Cannot connect to the Docker daemon' } : {};
  });

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
    log: () => {},
    engineClock: { now: clock.now, wait: clock.sleep },
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

test('it fails the build when the builder engine does not answer in 60 s, and removes the builder', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ code: 1, stderr: 'Cannot connect to the Docker daemon' }));

  // each poll's wait moves the clock on by its 500 ms
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
    log: () => {},
    engineClock: { now: clock.now, wait: clock.sleep },
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
    log: () => {},
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
    log: () => {},
  });

  // a rootfs of the image's size, at the path its digest names
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
  const logs: string[] = [];

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
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // the builder's Firecracker survives SIGKILL, so its removal fails
  ctx.fake.queue('stop', 'fail');

  const built = await builders.withBuilder(new AbortController().signal, () =>
    Promise.resolve('built'),
  );

  const survivors = await listImps(ctx.db);

  expect(built).toBe('built');
  expect(survivors.map((imp) => imp.kind)).toStrictEqual(['builder']);
  expect(timers.readPendingMs()).toStrictEqual([30_000]);

  expect(logs).toSatisfyAny((line: string) =>
    /^impd: image build: ERROR: builder imp-build-[a-z2-9]{8} survives its removal, tried again every 30 s: firecracker \d+ survived SIGKILL$/v.test(
      line,
    ),
  );
});

test('it removes a builder that survived its removal on a later retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

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
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // the first removal meets a Firecracker that survives SIGKILL; the
  // retry's stop goes through
  ctx.fake.queue('stop', 'fail');

  await builders.withBuilder(new AbortController().signal, () => Promise.resolve());

  const survivors = await listImps(ctx.db);

  timers.firePending();

  await waitFor(() => {
    expect(logs).toSatisfyAny((line: string) =>
      /^impd: image build: removed builder imp-build-[a-z2-9]{8}$/v.test(line),
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
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // a rootfs of the image's size, at the path its digest names
  await Bun.write(buildImagePaths(ctx.dataDir, 'sha256:base').rootfs, 'rootfs');

  await createImage(
    ctx.db,
    buildMockNewImage({ name: 'base', digest: 'sha256:base', sizeBytes: 6 }),
  );

  await ctx.impd.imps.createImp({ name: 'imp-build-left', image: 'base', kind: 'builder' });

  // the removal at start and the first retry meet a Firecracker that
  // survives SIGKILL; the second retry's stop goes through
  ctx.fake.queue('stop', 'fail', 'fail');

  await builders.removeLeftovers();

  timers.firePending();

  await waitFor(() => {
    expect(timers.readPendingMs()).toStrictEqual([30_000]);
  });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('impd: image build: removed builder imp-build-left');
  });

  const imps = await listImps(ctx.db);

  const errors = logs.filter((line) => line.includes('ERROR: builder imp-build-left'));

  expect(imps).toStrictEqual([]);
  expect(errors).toHaveLength(2);
});

test('it never removes a user imp that took the id of a removed builder on a retry', async () => {
  const ctx = await setupTest();

  const guest = buildStubGuest(() => ({ stdout: 'ok' }));
  const timers = buildStubClock();
  const logs: string[] = [];

  const builders = createBuilders({
    config: ctx.config,
    db: ctx.db,
    imps: {
      ...ctx.impd.imps,
      openBuilderExec: (_name, request) => guest.open(request),
    },
    ensureImage: () => Promise.resolve(),
    log: (message) => {
      logs.push(message);
    },
    startTimer: timers.startTimer,
  });

  // a rootfs of the image's size, at the path its digest names
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

  const record = await findImpByName(ctx.db, builder.name);

  invariant(record);

  const id = record.id;

  // the removal at start meets a Firecracker that survives SIGKILL
  ctx.fake.queue('stop', 'fail');

  await builders.removeLeftovers();

  // before the retry, the builder goes, and a user imp takes its id
  await ctx.impd.imps.destroyImpId(id);
  await ctx.impd.imps.createImp({ id, name: 'mine', image: 'base' });

  timers.firePending();

  await waitFor(() => {
    expect(logs).toContain('impd: image build: removed builder imp-build-left');
  });

  const imps = await listImps(ctx.db);

  expect(imps.map((imp) => [imp.id, imp.name, imp.kind])).toStrictEqual([[id, 'mine', 'user']]);
});

test('it ends an export over its file limit and removes its builder, with no client cancel', async () => {
  const ctx = await setupTest();
  const tree = await mkdtemp(join(tmpdir(), 'builder-stall-'));

  onTestFinished(() => rm(tree, { recursive: true, force: true }));

  const parents = Array.from({ length: 20 }, (_, n) => `d${String(n)}`).join('/');

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

  // the export sends its tar, then stalls without an exit
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
    log: () => {},
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree(
      exec,
      join(tree, 'root'),
      { maxBytes: 1024 ** 3, maxFiles: 1 },
      new AbortController().signal,
    ),
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

  // the export's exec opens only once the test lets it
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
    log: () => {},
  });

  const exporting = builders.withBuilder(new AbortController().signal, (exec) =>
    writeGuestTree(
      exec,
      join(tree, 'root'),
      { maxBytes: 1024 ** 3, maxFiles: 1000 },
      new AbortController().signal,
      () => Promise.resolve(),
      timers.startTimer,
    ),
  );

  await waitFor(() => {
    expect(reached.isExportOpening).toBeTrue();
  });

  // the idle limit falls due while the exec opens
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

  // a rootfs of the image's size, at the path its digest names
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

      // a user imp takes the builder's name just before its create
      createImp: async (input) => {
        await ctx.impd.imps.createImp({ name: input.name, image: 'base' });

        return ctx.impd.imps.createImp(input);
      },
    },
    ensureImage: async () => {
      await createBuilderImage({ db: ctx.db, dataDir: ctx.dataDir, ref: ctx.config.build.image });
    },
    log: () => {},
  });

  // a rootfs of the image's size, at the path its digest names
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
