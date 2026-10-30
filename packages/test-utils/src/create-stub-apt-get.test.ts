import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubAptGet } from '@impz/test-utils/create-stub-apt-get';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-apt-get-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it leaves its tools out of PATH until apt-get install runs', () => {
  const ctx = setupTest();
  const aptGet = createStubAptGet(ctx.directoryPath, ['mkfs.xfs']);

  expect(Bun.which('mkfs.xfs', { PATH: aptGet.bin })).toBeNull();
});

test('it installs its tools on apt-get install, as stubs that record their calls', () => {
  const ctx = setupTest();
  const aptGet = createStubAptGet(ctx.directoryPath, ['mkfs.xfs', 'xfs_repair']);

  Bun.spawnSync(['apt-get', 'install', '-y', 'xfsprogs'], { env: { PATH: aptGet.bin } });

  const formatted = Bun.spawnSync(['mkfs.xfs', '-q', 'disk.img'], { env: { PATH: aptGet.bin } });

  expect(formatted.exitCode).toBe(0);
  expect(Bun.which('xfs_repair', { PATH: aptGet.bin })).toBe(join(aptGet.bin, 'xfs_repair'));

  expect(readFileSync(aptGet.calls, 'utf8')).toBe(
    'apt-get install -y xfsprogs\nmkfs.xfs -q disk.img\n',
  );
});

test('it installs nothing on apt-get update', () => {
  const ctx = setupTest();
  const aptGet = createStubAptGet(ctx.directoryPath, ['mkfs.xfs']);
  const result = Bun.spawnSync(['apt-get', 'update'], { env: { PATH: aptGet.bin } });

  expect(result.exitCode).toBe(0);
  expect(Bun.which('mkfs.xfs', { PATH: aptGet.bin })).toBeNull();
});
