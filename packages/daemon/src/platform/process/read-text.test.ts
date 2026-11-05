import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRunPrefix } from '../../../testing/platform/format-run-prefix';
import { readRunOwner } from '../../../testing/platform/read-run-owner';
import { readText } from './read-text';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const directory = mkdtempSync(join(tmpdir(), `${prefix}imp-read-text-`));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it reads a file as utf8 text', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'notes.txt'), 'café\n');

  expect(readText(join(ctx.directory, 'notes.txt'))).toBe('café\n');
});

test('it throws for a file that is missing', () => {
  const ctx = setupTest();

  expect(() => readText(join(ctx.directory, 'missing.txt'))).toThrow(/ENOENT/u);
});
