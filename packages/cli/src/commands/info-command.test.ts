import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImage } from '@impz/daemon/src/platform/db/images';
import {
  buildImagePaths,
  buildImpPaths,
  buildMockNewImage,
  startStubInnerAgent,
} from '@impz/daemon/testing';
import { writeHostConfig } from '../config/host-store';
import { readJsonOutput } from '../test-utils/read-json-output';
import { runCLIInProcess } from '../test-utils/run-cli-in-process';
import { startImpdHost } from '../test-utils/start-impd-host';

// The CLI's home, where config.json keeps the saved hosts, so none of this
// machine's reaches it; the impd host a test starts releases into `stack`
async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'imp-cli-info-'));

  stack.defer(() => rm(directory, { recursive: true, force: true }));

  return { home: { HOME: directory, XDG_CONFIG_HOME: directory }, stack };
}

test('it shows an awake imp’s inner container as down, with its restarts and last error', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  const imp = await box.client.imps.create({ name: 'web' });

  // its agent answers, with the container down after three restarts
  await startStubInnerAgent(buildImpPaths(box.dataDir, imp.id).vsockSocket, {
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
    stack: ctx.stack,
  });

  await box.runIdleCheck();

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCLIInProcess({ args: ['info', 'web'], env: ctx.home });

  expect(shown.code).toBe(0);

  expect(shown.stdout.split('\n')).toIncludeAllMembers([
    'name        web',
    'state       running',
    'container   down',
    'restarts    3',
    'last error  start inner init: exit status 1',
  ]);
});

test('it shows an imp’s inner container as unknown before its agent answered', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCLIInProcess({ args: ['info', 'web'], env: ctx.home });

  expect(shown.stdout.split('\n')).toContain('container   unknown');
  expect(shown.stdout).not.toInclude('restarts');
});

test('it shows impd itself without a name', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCLIInProcess({ args: ['info'], env: ctx.home });

  expect(shown.stdout).toStartWith('version     ');
});

test('it prints impd’s --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCLIInProcess({ args: ['info', '--json'], env: ctx.home });

  expect(shown.code).toBe(0);
  expect(readJsonOutput('info', shown.stdout).data).toStrictEqual(JSON.parse(shown.stdout));
});

test('it prints an imp’s --json output in the shape of the committed schema', async () => {
  const ctx = await setupTest();
  const box = await startImpdHost(ctx.stack, { env: {} });

  const image = buildMockNewImage({ name: 'base', sizeBytes: 6 });

  await Bun.write(buildImagePaths(box.dataDir, image.digest).rootfs, 'rootfs');

  await createImage(box.db, image);

  await box.client.imps.create({ name: 'web' });

  writeHostConfig(ctx.home, {
    current: 'box',
    hosts: { box: { url: box.url, token: box.rootToken } },
  });

  const shown = await runCLIInProcess({ args: ['info', 'web', '--json'], env: ctx.home });

  expect(shown.code).toBe(0);
  expect(readJsonOutput('info <name>', shown.stdout).data).toStrictEqual(JSON.parse(shown.stdout));
});
