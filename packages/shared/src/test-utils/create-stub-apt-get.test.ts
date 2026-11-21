import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubAptGet } from '@impz/shared/test-utils/create-stub-apt-get';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-apt-get-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it leaves its tools out of PATH until apt-get install runs', () => {
  const ctx = setupTest();

  createStubAptGet(ctx.directoryPath, ['mkfs.xfs']);

  expect(Bun.which('mkfs.xfs', { PATH: ctx.directoryPath })).toBeNull();
});

test('it installs its tools on apt-get install, as stubs that record their calls', () => {
  const ctx = setupTest();

  createStubAptGet(ctx.directoryPath, ['mkfs.xfs', 'xfs_repair']);

  Bun.spawnSync(['apt-get', 'install', '-y', 'xfsprogs'], { env: { PATH: ctx.directoryPath } });

  const formatted = Bun.spawnSync(['mkfs.xfs', '-q', 'disk.img'], {
    env: { PATH: ctx.directoryPath },
  });

  expect(formatted.exitCode).toBe(0);

  expect(Bun.which('xfs_repair', { PATH: ctx.directoryPath })).toBe(
    join(ctx.directoryPath, 'xfs_repair'),
  );

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'apt-get install -y xfsprogs\nmkfs.xfs -q disk.img\n',
  );
});

test('it installs nothing on apt-get update', () => {
  const ctx = setupTest();

  createStubAptGet(ctx.directoryPath, ['mkfs.xfs']);

  const result = Bun.spawnSync(['apt-get', 'update'], { env: { PATH: ctx.directoryPath } });

  expect(result.exitCode).toBe(0);
  expect(Bun.which('mkfs.xfs', { PATH: ctx.directoryPath })).toBeNull();
});
