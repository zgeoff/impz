import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeDirectory } from './probe-directory.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-probe-directory-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it finds a directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'data'));

  expect(probeDirectory(join(ctx.directory, 'data'))).toBeTrue();
});

test('it follows a symlink to a directory', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'data'));
  symlinkSync(join(ctx.directory, 'data'), join(ctx.directory, 'link'));

  expect(probeDirectory(join(ctx.directory, 'link'))).toBeTrue();
});

test('it finds no directory at a file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'notes.txt'), 'notes');

  expect(probeDirectory(join(ctx.directory, 'notes.txt'))).toBeFalse();
});

test('it finds no directory at a path that is missing', () => {
  const ctx = setupTest();

  expect(probeDirectory(join(ctx.directory, 'missing'))).toBeFalse();
});
