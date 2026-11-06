import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRunPrefix } from './format-run-prefix';
import { readMigrationsHash } from './read-migrations-hash';
import { readRunOwner } from './read-run-owner';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const dbDirectory = mkdtempSync(join(tmpdir(), `${prefix}imp-migrations-hash-`));

  onTestFinished(() => {
    rmSync(dbDirectory, { recursive: true, force: true });
  });

  mkdirSync(join(dbDirectory, 'migrations'));

  return { dbDirectory };
}

test('it changes the hash when a migration changes under the same name', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dbDirectory, 'run-migrations.ts'), 'export const MIGRATIONS = {};');

  writeFileSync(
    join(ctx.dbDirectory, 'migrations', 'migration-001-add-notes.ts'),
    'CREATE TABLE notes',
  );

  const before = readMigrationsHash(ctx.dbDirectory);

  writeFileSync(
    join(ctx.dbDirectory, 'migrations', 'migration-001-add-notes.ts'),
    'CREATE TABLE notes (body TEXT)',
  );

  expect(readMigrationsHash(ctx.dbDirectory)).not.toBe(before);
});

test('it changes the hash when a migration file is added', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dbDirectory, 'run-migrations.ts'), 'export const MIGRATIONS = {};');

  writeFileSync(
    join(ctx.dbDirectory, 'migrations', 'migration-001-add-notes.ts'),
    'CREATE TABLE notes',
  );

  const before = readMigrationsHash(ctx.dbDirectory);

  writeFileSync(
    join(ctx.dbDirectory, 'migrations', 'migration-002-add-tags.ts'),
    'CREATE TABLE tags',
  );

  expect(readMigrationsHash(ctx.dbDirectory)).not.toBe(before);
});

test('it gives the same files the same hash', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dbDirectory, 'run-migrations.ts'), 'export const MIGRATIONS = {};');

  writeFileSync(
    join(ctx.dbDirectory, 'migrations', 'migration-001-add-notes.ts'),
    'CREATE TABLE notes',
  );

  const before = readMigrationsHash(ctx.dbDirectory);

  expect(readMigrationsHash(ctx.dbDirectory)).toBe(before);
});
