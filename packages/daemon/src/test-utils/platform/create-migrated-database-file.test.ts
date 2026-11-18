import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNames } from '../../platform/db/read-names';
import { createMigratedDatabaseFile } from './create-migrated-database-file';
import { formatRunPrefix } from './format-run-prefix';
import { readRunOwner } from './read-run-owner';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const directory = mkdtempSync(join(tmpdir(), `${prefix}imp-migrated-file-`));

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

  const names = readNames(opened.query('SELECT name FROM kysely_migration ORDER BY name').all());

  expect(names).toStrictEqual(['001_create_initial_schema', '002_add_imp_http_port']);
});
