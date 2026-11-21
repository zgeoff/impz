import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubZfs } from './create-stub-zfs';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-zfs-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the userland and module versions for version', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'zfs'), 'version']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'zfs-2.3.4-1\nzfs-kmod-2.3.4-1\n',
  });
});

test('it succeeds a create silently', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath);

  const result = Bun.spawnSync([
    join(ctx.directoryPath, 'zfs'),
    'create',
    '-o',
    'mountpoint=legacy',
    'tank/imp',
  ]);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails a create when told to', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath, { create: 'fails' });

  const result = Bun.spawnSync([
    join(ctx.directoryPath, 'zfs'),
    'create',
    '-o',
    'mountpoint=legacy',
    'tank/imp',
  ]);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'cannot create dataset\n',
  });
});

test('it prints the version when only a create fails', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath, { create: 'fails' });

  expect(Bun.spawnSync([join(ctx.directoryPath, 'zfs'), 'version']).stdout.toString()).toBe(
    'zfs-2.3.4-1\nzfs-kmod-2.3.4-1\n',
  );
});

test('it succeeds any other command silently', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'zfs'), 'list', '-r', 'tank']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it logs each call to the shared stub log', () => {
  const ctx = setupTest();

  createStubZfs(ctx.directoryPath);

  Bun.spawnSync([join(ctx.directoryPath, 'zfs'), 'version']);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('zfs version\n');
});
