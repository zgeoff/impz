import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@zgeoff/testing/bin';
import { buildStubNpmView } from './build-stub-npm-view';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-npm-view-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the version of a published package', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'npm', {
    script: buildStubNpmView(['@impz/client@3.1.4']),
  });

  const result = Bun.spawnSync(['npm', 'view', '@impz/client@3.1.4', 'version'], {
    env: { PATH: ctx.directoryPath },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '3.1.4\n',
  });
});

test('it fails with E404 for a version the registry lacks', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'npm', {
    script: buildStubNpmView(['@impz/client@3.1.4']),
  });

  const result = Bun.spawnSync(['npm', 'view', '@impz/testing@3.1.4', 'version'], {
    env: { PATH: ctx.directoryPath },
  });

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'npm error code E404\n',
  });
});

test('it fails any command other than npm view of a version', () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'npm', {
    script: buildStubNpmView(['@impz/client@3.1.4']),
  });

  const result = Bun.spawnSync(['npm', 'publish', '@impz/client@3.1.4'], {
    env: { PATH: ctx.directoryPath },
  });

  expect(result.exitCode).toBe(1);
});
