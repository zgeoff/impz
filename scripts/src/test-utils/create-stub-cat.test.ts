import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubCat } from './create-stub-cat';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-cat-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it prints the line it was given for a listed file', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'cat'), '/proc/self/cgroup']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '0::/\n',
  });
});

test('it prints a line that holds quotes and spaces as it was given', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, {
    "/proc/it's here": `0::/system.slice/"docker".scope`,
  });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'cat'), "/proc/it's here"]);

  expect(result.stdout.toString()).toBe('0::/system.slice/"docker".scope\n');
});

test('it reads a file it was not given with the real cat', () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'cgroup.procs');

  writeFileSync(file, '1\n42\n');
  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'cat'), file]);

  expect(result.stdout.toString()).toBe('1\n42\n');
});

test('it fails as the real cat does for a missing file it was not given', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'cat'), join(ctx.directoryPath, 'none')]);

  expect(result.exitCode).toBe(1);
});

test('it hands more than one file to the real cat, a listed one included', () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'cgroup.procs');

  writeFileSync(file, '1\n');
  createStubCat(ctx.directoryPath, { [file]: '0::/' });

  const result = Bun.spawnSync([join(ctx.directoryPath, 'cat'), file, file]);

  expect(result.stdout.toString()).toBe('1\n1\n');
});

test('it logs each call with its arguments', () => {
  const ctx = setupTest();

  createStubCat(ctx.directoryPath, { '/proc/self/cgroup': '0::/' });

  Bun.spawnSync([join(ctx.directoryPath, 'cat'), '/proc/self/cgroup']);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe('cat /proc/self/cgroup\n');
});
