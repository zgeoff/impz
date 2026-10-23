import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSecretText } from './write-secret-text.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-write-secret-text-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it writes the text in a new folder, readable by its owner only', () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'data', 'oauth.json');

  writeSecretText(file, '{"clientSecret":"fake-secret"}\n');

  expect(readFileSync(file, 'utf8')).toBe('{"clientSecret":"fake-secret"}\n');
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

test('it narrows an existing file to its owner as it replaces the text', () => {
  const ctx = setupTest();
  const file = join(ctx.directory, 'oauth.json');

  writeFileSync(file, 'old', { mode: 0o644 });
  writeSecretText(file, 'new');

  expect(statSync(file).mode & 0o777).toBe(0o600);
});
