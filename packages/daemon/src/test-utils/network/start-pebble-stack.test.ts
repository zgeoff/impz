import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { updateEnv } from '@zgeoff/testing';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { startPebbleStack } from './start-pebble-stack';

async function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const directory = await mkdtemp(join(tmpdir(), 'pebble-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { stack, directoryPath: directory };
}

test('it refuses a Pebble container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${['case "$*" in', '  *-pebble) exit 0 ;;', 'esac', 'exit 1'].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toMatchObject({
    message: 'a container named imp-acme-it-x-pebble is already there',
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('it refuses a challtestsrv container name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${['case "$*" in', '  *-challtestsrv) exit 0 ;;', 'esac', 'exit 1'].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toMatchObject({
    message: 'a container named imp-acme-it-x-challtestsrv is already there',
  });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('it refuses a network name that is taken, before it makes anything', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${['case "$*" in', '  "network inspect "*) exit 0 ;;', 'esac', 'exit 1'].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toMatchObject({ message: 'a network named imp-acme-it-x-acme is already there' });

  expect(calls.split('\n')).toStrictEqual([
    'docker container inspect imp-acme-it-x-pebble',
    'docker container inspect imp-acme-it-x-challtestsrv',
    'docker network inspect imp-acme-it-x-acme',
    '',
  ]);
});

test('it joins a network that is there when told to reuse it, and leaves that network in place', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${[
      'case "$*" in',
      '  "network inspect "*) exit 0 ;;',
      '  *inspect*) exit 1 ;;',
      '  "start imp-acme-it-x-pebble") exit 1 ;;',
      'esac',
    ].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
    reuseNetwork: true,
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toMatchObject({ message: 'docker start imp-acme-it-x-pebble exited 1: ' });

  expect(calls.split('\n').filter((line) => line.startsWith('docker network '))).toStrictEqual([
    'docker network inspect imp-acme-it-x-acme',
  ]);
});

test('it removes only what it made when the Pebble container is not created', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${[
      'case "$*" in',
      '  *inspect*) exit 1 ;;',
      '  *"--name imp-acme-it-x-pebble "*) exit 1 ;;',
      'esac',
    ].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toBeInstanceOf(Error);

  expect(calls.split('\n').filter((line) => line.includes(' rm '))).toStrictEqual([
    'docker rm --force imp-acme-it-x-challtestsrv',
    'docker network rm imp-acme-it-x-acme',
  ]);
});

test('it removes the Pebble container it created when that container does not start', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${[
      'case "$*" in',
      '  *inspect*) exit 1 ;;',
      '  "start imp-acme-it-x-pebble") exit 1 ;;',
      'esac',
    ].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toMatchObject({ message: 'docker start imp-acme-it-x-pebble exited 1: ' });

  expect(calls.split('\n').filter((line) => line.includes(' rm '))).toStrictEqual([
    'docker rm --force imp-acme-it-x-pebble',
    'docker rm --force imp-acme-it-x-challtestsrv',
    'docker network rm imp-acme-it-x-acme',
  ]);
});

test('it copies the minica PEM into the directory the caller names', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: `#!/bin/bash\n${['case "$*" in', '  *inspect*|"cp "*) exit 1 ;;', 'esac'].join('\n')}`,
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const failure = await startPebbleStack(ctx.stack, 'imp-acme-it-x', {
    minicaDir: join(ctx.directoryPath, 'ca'),
  }).then(
    () => null,
    (error: unknown) => error,
  );

  await ctx.stack.disposeAsync();

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(failure).toBeInstanceOf(Error);

  expect(calls.split('\n')).toContain(
    `docker cp imp-acme-it-x-pebble:/test/certs/pebble.minica.pem ${join(ctx.directoryPath, 'ca', 'imp-acme-it-x-pebble-minica.pem')}`,
  );
});
