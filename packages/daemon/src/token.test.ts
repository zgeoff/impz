import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateToken } from './token';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-token-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it makes a token of 32 random bytes in base64url on first start', () => {
  const ctx = setupTest();
  const token = loadOrCreateToken(ctx.directoryPath);

  expect(token).toMatch(/^[\w-]{43}$/u);
});

test('it makes a different token for each new data dir', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'a'));
  mkdirSync(join(ctx.directoryPath, 'b'));

  const first = loadOrCreateToken(join(ctx.directoryPath, 'a'));
  const second = loadOrCreateToken(join(ctx.directoryPath, 'b'));

  expect(second).not.toBe(first);
});

test('it keeps the token it makes in a file the owner alone may read', () => {
  const ctx = setupTest();
  const token = loadOrCreateToken(ctx.directoryPath);

  expect(readFileSync(join(ctx.directoryPath, 'token'), 'utf8')).toBe(`${token}\n`);
  expect(statSync(join(ctx.directoryPath, 'token')).mode & 0o777).toBe(0o600);
});

test('it reads back the token it made on a later start', () => {
  const ctx = setupTest();
  const made = loadOrCreateToken(ctx.directoryPath);

  expect(loadOrCreateToken(ctx.directoryPath)).toBe(made);
});

test('it reads a token file another process wrote, without its surrounding whitespace', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.directoryPath, 'token'), '  operator-token \n');

  expect(loadOrCreateToken(ctx.directoryPath)).toBe('operator-token');
});

test('it throws when the data dir does not exist', () => {
  const ctx = setupTest();

  expect(() => loadOrCreateToken(join(ctx.directoryPath, 'missing'))).toThrow(/ENOENT/u);
});
