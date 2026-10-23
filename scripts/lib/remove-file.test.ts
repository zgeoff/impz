import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeFile } from './remove-file.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-remove-file-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it removes a file', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'notes.txt'), 'notes');
  removeFile(join(ctx.directory, 'notes.txt'));

  expect(existsSync(join(ctx.directory, 'notes.txt'))).toBeFalse();
});

test('it leaves a path that is missing as it is', () => {
  const ctx = setupTest();

  expect(() => {
    removeFile(join(ctx.directory, 'missing.txt'));
  }).not.toThrow();
});
