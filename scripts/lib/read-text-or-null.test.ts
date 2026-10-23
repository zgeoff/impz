import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextOrNull } from './read-text-or-null.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-read-text-or-null-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it reads a file as utf8 text', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'notes.txt'), 'café\n');

  expect(readTextOrNull(join(ctx.directory, 'notes.txt'))).toBe('café\n');
});

test('it reads a file that is missing as null', () => {
  const ctx = setupTest();

  expect(readTextOrNull(join(ctx.directory, 'missing.txt'))).toBeNull();
});

test('it reads a directory as null', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directory, 'data'));

  expect(readTextOrNull(join(ctx.directory, 'data'))).toBeNull();
});
