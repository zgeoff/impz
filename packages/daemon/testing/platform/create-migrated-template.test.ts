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
  utimesSync,
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

test('it marks the template as used on each call', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  const twoHoursAgo = new Date(Date.now() - 7_200_000);

  utimesSync(template, twoHoursAgo, twoHoursAgo);

  await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(statSync(template).mtimeMs).toBeWithin(Date.now() - 60_000, Date.now() + 1);
});

test('it removes the files of older migrations unused for an hour when it builds one', async () => {
  const ctx = setupTest();

  const twoHoursAgo = new Date(Date.now() - 7_200_000);

  for (const name of [
    '003_add_broker-0123456789abcdef.sqlite',
    '003_add_broker-0123456789abcdef.sqlite.lock',
    `pid${String(process.pid)}-ns${ctx.pidNamespace}-003_add_broker-0123456789abcdef.sqlite`,
  ]) {
    writeFileSync(join(ctx.cacheDirectory, name), '');
    utimesSync(join(ctx.cacheDirectory, name), twoHoursAgo, twoHoursAgo);
  }

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual([basename(template)]);
});

test('it keeps the files of older migrations that a running build holds', async () => {
  const ctx = setupTest();
  const owner = `pid${String(process.pid)}-ns${ctx.pidNamespace}`;

  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'), '');
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite.lock'), owner);
  writeFileSync(join(ctx.cacheDirectory, `${owner}-003_add_broker-0123456789abcdef.sqlite`), '');

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  expect(readdirSync(ctx.cacheDirectory).toSorted()).toStrictEqual(
    [
      '003_add_broker-0123456789abcdef.sqlite',
      '003_add_broker-0123456789abcdef.sqlite.lock',
      `${owner}-003_add_broker-0123456789abcdef.sqlite`,
      basename(template),
    ].toSorted(),
  );
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

test('it builds the template when a lock is older than 30 s, whatever its owner', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  const aMinuteAgo = new Date(Date.now() - 60_000);

  rmSync(template);
  writeFileSync(`${template}.lock`, '');
  utimesSync(`${template}.lock`, aMinuteAgo, aMinuteAgo);

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

test('it leaves a fresh lock of a run in another PID namespace', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  rmSync(template);
  writeFileSync(`${template}.lock`, 'pid1-ns1');

  const waited = createMigratedTemplate(ctx.cacheDirectory, '003_add_broker');

  writeFileSync(template, 'built in another sandbox');

  await waited;

  expect(readFileSync(`${template}.lock`, 'utf8')).toBe('pid1-ns1');
});
