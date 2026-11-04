import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createMigratedTemplate } from './create-migrated-template';

function setupTest() {
  const cacheDirectory = mkdtempSync(join(tmpdir(), 'imp-template-'));

  onTestFinished(() => {
    rmSync(cacheDirectory, { recursive: true, force: true });
  });

  const pidNamespace = readlinkSync('/proc/self/ns/pid').replaceAll(/\D/gu, '');

  return { cacheDirectory, pidNamespace };
}

test('it migrates the template up to the migration it names', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  const opened = new Database(template, { readonly: true });

  onTestFinished(() => {
    opened.close();
  });

  const names = opened
    .query<{ name: string }, []>('SELECT name FROM kysely_migration ORDER BY name')
    .all()
    .map((row) => row.name);

  expect(names).toStrictEqual([
    '001_create_initial_schema',
    '002_add_imp_http_port',
    '003_add_broker',
  ]);
});

test('it reuses the template it built on the next call', async () => {
  const ctx = setupTest();

  const first = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  const built = statSync(first).ino;

  const second = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(statSync(second).ino).toBe(built);
});

test('it removes the files of a template whose migrations changed when it builds one', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'), '');
  writeFileSync(join(ctx.cacheDirectory, 'pid7-ns9-003_add_broker-0123456789abcdef.sqlite'), '');

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual([basename(template)]);
});

test('it builds the template when a killed run left its lock', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  const exited = Bun.spawn(['true']);

  await exited.exited;

  rmSync(template);
  writeFileSync(`${template}.lock`, `pid${String(exited.pid)}-ns${ctx.pidNamespace}`);

  await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(existsSync(template)).toBeTrue();
});

test('it waits for the template that a running build holds the lock for', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  rmSync(template);
  writeFileSync(`${template}.lock`, `pid${String(process.pid)}-ns${ctx.pidNamespace}`);

  const waited = createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  writeFileSync(template, 'built by the run that holds the lock');

  await waited;

  expect(readFileSync(template, 'utf8')).toBe('built by the run that holds the lock');
});

test('it leaves the lock of a run in another PID namespace', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  rmSync(template);
  writeFileSync(`${template}.lock`, 'pid1-ns1');

  const waited = createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  writeFileSync(template, 'built in another sandbox');

  await waited;

  expect(readFileSync(`${template}.lock`, 'utf8')).toBe('pid1-ns1');
});
