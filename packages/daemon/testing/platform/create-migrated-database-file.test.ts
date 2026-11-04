import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMigratedDatabaseFile } from './create-migrated-database-file';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-migrated-file-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it writes a database file migrated up to the migration it names', async () => {
  const ctx = setupTest();

  await createMigratedDatabaseFile(join(ctx.directory, 'imp.sqlite'), '002_add_imp_http_port');

  const opened = new Database(join(ctx.directory, 'imp.sqlite'), { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  const names = opened
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name);

  expect(names).toStrictEqual(['001_create_initial_schema', '002_add_imp_http_port']);
});

test('it closes the template database when a migration fails', () => {
  const ctx = setupTest();
  const created = createMigratedDatabaseFile(join(ctx.directory, 'imp.sqlite'), '999_unknown');

  expect(created).rejects.toThrow('999_unknown');

  // Linux still lists a removed file that a descriptor holds open
  const descriptors = Bun.spawnSync(['ls', '-l', `/proc/${String(process.pid)}/fd`]);

  expect(descriptors.stdout.toString()).not.toInclude('migrated-templates');
});

test('it gives each file a copy that a write to another file leaves alone', async () => {
  const ctx = setupTest();

  await createMigratedDatabaseFile(join(ctx.directory, 'first.sqlite'), '002_add_imp_http_port');

  const first = new Database(join(ctx.directory, 'first.sqlite'));

  onTestFinished(() => {
    first.close();
  });

  first.run('CREATE TABLE notes (body TEXT)');

  await createMigratedDatabaseFile(join(ctx.directory, 'second.sqlite'), '002_add_imp_http_port');

  const second = new Database(join(ctx.directory, 'second.sqlite'), { readonly: true });

  onTestFinished(() => {
    second.close();
  });

  const notes = second
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'notes'")
    .all();

  expect(notes).toStrictEqual([]);
});
