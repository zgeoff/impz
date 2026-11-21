import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { updateEnv } from '@zgeoff/testing';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { runDocker } from './run-docker';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'run-docker-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it returns the standard output of a docker command that succeeds', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: '#!/bin/bash\necho 5f0c2a9e',
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  const stdout = await runDocker(['network', 'create', 'imp-wt-acme']);

  expect(stdout).toBe('5f0c2a9e\n');
});

test('it passes its arguments to docker as they are', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker');
  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  await runDocker(['network', 'create', 'imp-wt-acme']);

  const calls = formatStubCalls(readStubCalls(ctx.directoryPath));

  expect(calls).toBe('docker network create imp-wt-acme\n');
});

test('it refuses a docker command that fails, with its arguments, exit code and standard error', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: '#!/bin/bash\necho "no such network" >&2\nexit 3',
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  expect(runDocker(['network', 'rm', 'imp-wt-acme'])).rejects.toThrowWithMessage(
    Error,
    'docker network rm imp-wt-acme exited 3: no such network',
  );
});

test('it names the standard output of a failed docker command that wrote no error', async () => {
  const ctx = await setupTest();

  createStubBin(ctx.directoryPath, 'docker', {
    script: '#!/bin/bash\necho "half done"\nexit 1',
  });

  updateEnv('PATH', `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`);

  expect(runDocker(['start', 'imp-wt-pebble'])).rejects.toThrowWithMessage(
    Error,
    'docker start imp-wt-pebble exited 1: half done',
  );
});
