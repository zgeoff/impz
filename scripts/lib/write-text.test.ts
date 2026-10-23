import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeText } from './write-text.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-write-text-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it writes the text to a new file', () => {
  const ctx = setupTest();

  writeText(join(ctx.directory, 'notes.txt'), 'first line\n');

  expect(readFileSync(join(ctx.directory, 'notes.txt'), 'utf8')).toBe('first line\n');
});

test('it replaces the text of a file that exists', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directory, 'notes.txt'), 'an older and longer text\n');
  writeText(join(ctx.directory, 'notes.txt'), 'new\n');

  expect(readFileSync(join(ctx.directory, 'notes.txt'), 'utf8')).toBe('new\n');
});
