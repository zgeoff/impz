import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-pick-data-dir-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'env'), '');

  return {
    directoryPath: directory,
    githubEnv: join(directory, 'env'),
    owner: `${String(process.getuid?.())}:${String(process.getgid?.())}`,
    scriptPath: join(import.meta.dir, 'pick-data-dir.ts'),
  };
}

test('it puts the data dir and its siblings on /mnt when the runner mounts a disk there', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  createStubBin(ctx.directoryPath, 'df');
  createStubBin(ctx.directoryPath, 'mountpoint');

  const result =
    await $`${process.execPath} ${ctx.scriptPath} IMP_DEV_DATA /mnt/imp-e2e /work/.data/ci -mv-b`
      .env({ PATH: sudo.bin, GITHUB_ENV: ctx.githubEnv })
      .nothrow()
      .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.githubEnv, 'utf8')).toBe('IMP_DEV_DATA=/mnt/imp-e2e\n');

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    [
      'df -h / /mnt',
      'mountpoint -q /mnt',
      'sudo mkdir -p /mnt/imp-e2e /mnt/imp-e2e-mv-b',
      `sudo chown ${ctx.owner} /mnt/imp-e2e /mnt/imp-e2e-mv-b`,
      '',
    ].join('\n'),
  );
});

test('it puts the data dir in its fallback when /mnt is no mount point', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo');

  createStubBin(ctx.directoryPath, 'df', 'exit 1');
  createStubBin(ctx.directoryPath, 'mountpoint', 'exit 32');

  const result =
    await $`${process.execPath} ${ctx.scriptPath} IMP_ZFS_TEST_DIR /mnt/imp-zfs /runner/temp/imp-zfs`
      .env({ PATH: sudo.bin, GITHUB_ENV: ctx.githubEnv })
      .nothrow()
      .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.githubEnv, 'utf8')).toBe('IMP_ZFS_TEST_DIR=/runner/temp/imp-zfs\n');

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    [
      'df -h / /mnt',
      'mountpoint -q /mnt',
      'sudo mkdir -p /runner/temp/imp-zfs',
      `sudo chown ${ctx.owner} /runner/temp/imp-zfs`,
      '',
    ].join('\n'),
  );
});

test('it fails, naming no data dir, when it cannot make the data dir', async () => {
  const ctx = setupTest();
  const sudo = createStubBin(ctx.directoryPath, 'sudo', 'exit 1');

  createStubBin(ctx.directoryPath, 'df');
  createStubBin(ctx.directoryPath, 'mountpoint');

  const result =
    await $`${process.execPath} ${ctx.scriptPath} IMP_DEV_DATA /mnt/imp-e2e /work/.data/ci`
      .env({ PATH: sudo.bin, GITHUB_ENV: ctx.githubEnv })
      .nothrow()
      .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.githubEnv, 'utf8')).toBe('');
});
