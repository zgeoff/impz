import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildImagePaths, buildMockNewImage, createImage } from '@impz/daemon/testing';
import { waitFor } from '@impz/test-utils/wait-for';
import * as z from 'zod';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startImpdHost } from '../test-utils/start-impd-host';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-bench-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  const box = await startImpdHost(stack, { env: {} });

  return { home: { HOME: directory, XDG_CONFIG_HOME: directory }, box };
}

test('it times each scenario at each concurrency, with the figures impd recorded', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const result = await runCLIInProcess({
    args: [
      'bench',
      'create,wake,restore',
      '--concurrency',
      '1,2',
      '--samples',
      '2',
      '--image',
      'base',
      '--json',
    ],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  const timed = {
    samples: 2,
    failures: {},
    latencyMs: expect.objectContaining({ p50: expect.any(Number), p99: expect.any(Number) }),
    impdMs: expect.objectContaining({ p50: expect.any(Number) }),
    memFileMib: null,
  };

  expect(result.code).toBe(0);

  const report = z.looseObject({ results: z.array(z.unknown()) }).parse(JSON.parse(result.stdout));

  expect(report.results).toStrictEqual([
    { scenario: 'create', concurrency: 1, ...timed },
    { scenario: 'create', concurrency: 2, ...timed },
    { scenario: 'wake', concurrency: 1, ...timed },
    { scenario: 'wake', concurrency: 2, ...timed },
    { scenario: 'restore', concurrency: 1, ...timed },
    { scenario: 'restore', concurrency: 2, ...timed },
  ]);
});

test('it removes every imp it made once the run ends', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  await ctx.box.client.imps.create({ name: 'keep', image: 'base' });

  await runCLIInProcess({
    args: ['bench', 'create,restore', '--concurrency', '2', '--samples', '2', '--image', 'base'],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  const imps = await ctx.box.client.imps.list();

  expect(imps.map((imp) => imp.name)).toStrictEqual(['keep']);
});

test('it reports the memory file of each sleep from impd', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const result = await runCLIInProcess({
    args: ['bench', 'sleep', '--concurrency', '1', '--samples', '1', '--image', 'base', '--json'],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  const report = z.looseObject({ results: z.array(z.unknown()) }).parse(JSON.parse(result.stdout));

  expect(report.results).toMatchObject([
    { scenario: 'sleep', samples: 1, memFileMib: { p50: expect.any(Number) } },
  ]);
});

test('it counts each refused step by its code, and fails a concurrency with no sample', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const result = await runCLIInProcess({
    args: ['bench', 'create', '--concurrency', '2', '--samples', '2', '--memory', '1t', '--json'],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  expect(result.code).toBe(1);

  const report = z.looseObject({ results: z.array(z.unknown()) }).parse(JSON.parse(result.stdout));

  expect(report.results).toMatchObject([
    { scenario: 'create', samples: 0, failures: { RAM_BUDGET_EXCEEDED: 2 }, latencyMs: null },
  ]);

  expect(result.stderr).toEndWith('impz: bench: create at 2 took no sample\n');
});

test('it prints the report and fails a run whose median step took longer than --limit-p50-ms', async () => {
  const ctx = await setupTest();

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(ctx.box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(ctx.box.db, image);

  const boot = ctx.box.fake.hold('boot');

  const running = runCLIInProcess({
    args: ['bench', 'create', '--concurrency', '1', '--samples', '1', '--limit-p50-ms', '1'],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  await boot.reached;

  const heldAt = performance.now();

  // the timed create waits on the held boot, so its time passes the limit
  await waitFor(() => {
    expect(performance.now() - heldAt).toBeGreaterThan(5);
  });

  boot.release();

  const result = await running;

  expect(result.code).toBe(1);
  expect(result.stdout).toInclude('create');
  expect(result.stderr).toMatch(/impz: bench: the median create at 1 took \d+ms, past 1ms\n$/u);
});

test('it names the host its numbers came from, and the boot templates before and after', async () => {
  const ctx = await setupTest();

  const result = await runCLIInProcess({
    args: [
      'bench',
      'create',
      '--concurrency',
      '1',
      '--samples',
      '1',
      '--label',
      'rack-7',
      '--json',
    ],
    env: { ...ctx.home, IMP_URL: ctx.box.url, IMP_TOKEN: ctx.box.rootToken },
  });

  const report = z
    .looseObject({ host: z.unknown(), before: z.unknown() })
    .parse(JSON.parse(result.stdout));

  expect(report.host).toMatchObject({
    label: 'rack-7',
    kernel: expect.any(String),
    isNested: expect.any(Boolean),
    hugePages: 'off',
  });

  expect(report.before).toStrictEqual({
    bootTemplates: null,
    hugePoolFreeMib: expect.toBeOneOf([null, expect.any(Number)]),
    awakeCount: 0,
    impCount: 0,
  });
});

test('it refuses a scenario it does not know, and names the ones it does', async () => {
  const result = await runCLIInProcess({
    args: ['bench', 'boot'],
    env: { IMP_URL: 'http://127.0.0.1:1' },
  });

  expect(result).toStrictEqual({
    stdout: '',
    stderr: 'impz: no bench scenario boot; pick from create, wake, wake-young, restore, sleep\n',
    code: 2,
  });
});
