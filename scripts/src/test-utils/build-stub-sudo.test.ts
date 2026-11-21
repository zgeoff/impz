import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { buildStubSudo } from './build-stub-sudo';

function setupTest() {
  const directory = mkdtempSync(`${tmpdir()}/imp-stub-sudo-`);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it records each line that sudo tee reads after the call', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'sudo', { script: buildStubSudo(), recordStdin: true });

  const result = Bun.spawnSync(['sudo', 'tee', '-a', '/etc/hosts'], {
    env: { PATH: ctx.directoryPath },
    stdin: Buffer.from('10.0.0.7 cache.test\n10.0.0.8 mirror.test\n'),
  });

  expect(result.exitCode).toBe(0);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'sudo tee -a /etc/hosts\n< 10.0.0.7 cache.test\n< 10.0.0.8 mirror.test\n',
  );
});

test('it refuses a tee to a path it is told to refuse, with the error tee prints', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'sudo', {
    script: buildStubSudo({ refusedTees: ['/proc/sys/vm/nr_hugepages'] }),
    recordStdin: true,
  });

  const result = Bun.spawnSync(['sudo', 'tee', '/proc/sys/vm/nr_hugepages'], {
    env: { PATH: ctx.directoryPath },
    stdin: Buffer.from('512\n'),
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'tee: /proc/sys/vm/nr_hugepages: Invalid argument\n',
  });

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'sudo tee /proc/sys/vm/nr_hugepages\n< 512\n',
  );
});

test('it passes a tee to any other path', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'sudo', {
    script: buildStubSudo({ refusedTees: ['/proc/sys/vm/nr_hugepages'] }),
  });

  const result = Bun.spawnSync(['sudo', 'tee', '/sys/kernel/mm/ksm/run'], {
    env: { PATH: ctx.directoryPath },
    stdin: Buffer.from('1\n'),
  });

  expect(result.exitCode).toBe(0);
});

test('it hands a command it runs on to the stand-in of that name, and answers with its exit code', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'sudo', { script: buildStubSudo({ runs: ['apt-get'] }) });
  createStubBin(ctx.directoryPath, 'apt-get', { script: '#!/bin/bash\nexit 7' });

  const result = Bun.spawnSync(['sudo', 'apt-get', 'update'], { env: { PATH: ctx.directoryPath } });

  expect(result.exitCode).toBe(7);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'sudo apt-get update\napt-get update\n',
  );
});
