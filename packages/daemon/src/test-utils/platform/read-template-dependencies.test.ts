import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyMigratedTemplate } from './copy-migrated-template';
import { formatRunPrefix } from './format-run-prefix';
import { readRunOwner } from './read-run-owner';
import { readTemplateDependencies } from './read-template-dependencies';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const directory = mkdtempSync(join(tmpdir(), `${prefix}imp-template-dependencies-`));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directory,
    dependencies: readTemplateDependencies(join(directory, 'cache')),
  };
}

test('it builds a template migrated up to the migration it names', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(
    join(ctx.directory, 'imp.sqlite'),
    '002_add_imp_http_port',
    ctx.dependencies,
  );

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

  const copied = copyMigratedTemplate(
    join(ctx.directory, 'imp.sqlite'),
    '999_unknown',
    ctx.dependencies,
  );

  expect(copied).rejects.toThrow('999_unknown');

  // Linux still lists a removed file that a descriptor holds open
  const descriptors = Bun.spawnSync(['ls', '-l', `/proc/${String(process.pid)}/fd`]);

  expect(descriptors.stdout.toString()).not.toInclude(ctx.directory);
});

test('it gives each file a copy that a write to another file leaves alone', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(
    join(ctx.directory, 'first.sqlite'),
    '002_add_imp_http_port',
    ctx.dependencies,
  );

  const first = new Database(join(ctx.directory, 'first.sqlite'));

  onTestFinished(() => {
    first.close();
  });

  first.run('CREATE TABLE notes (body TEXT)');

  await copyMigratedTemplate(
    join(ctx.directory, 'second.sqlite'),
    '002_add_imp_http_port',
    ctx.dependencies,
  );

  const second = new Database(join(ctx.directory, 'second.sqlite'), { readonly: true });

  onTestFinished(() => {
    second.close();
  });

  const notes = second
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE name = 'notes'")
    .all();

  expect(notes).toStrictEqual([]);
});
