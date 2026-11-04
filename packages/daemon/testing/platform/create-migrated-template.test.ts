import { Database } from 'bun:sqlite';
import { expect, onTestFinished, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

  const dependencies = {
    owner: { pid: 4182, namespace: '4026531836' },
    now: Date.now,
    probeProcessRunning: () => true,
  };

  return { cacheDirectory, dependencies };
}

test('it migrates the template up to the migration it names', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

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

  const first = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  const built = statSync(first).ino;

  const second = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  expect(statSync(second).ino).toBe(built);
});

test('it marks the template as used on each call', async () => {
  const ctx = setupTest();

  await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', ctx.dependencies);

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', {
    ...ctx.dependencies,
    now: () => 1_800_000_000_000,
  });

  expect(statSync(template).mtimeMs).toBe(1_800_000_000_000);
});

test('it removes the files of older migrations unused for an hour when it builds one', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'), '');
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite.lock'), '');

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4182-ns4026531836-003_add_broker-0123456789abcdef.sqlite'),
    '',
  );

  const template = await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', {
    ...ctx.dependencies,
    now: () => Date.now() + 7_200_000,
  });

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual([basename(template)]);
});

test('it keeps the files of older migrations that a running build holds', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'), '');

  writeFileSync(
    join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite.lock'),
    'pid4183-ns4026531836',
  );

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-003_add_broker-0123456789abcdef.sqlite'),
    '',
  );

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  expect(readdirSync(ctx.cacheDirectory).toSorted()).toStrictEqual(
    [
      '003_add_broker-0123456789abcdef.sqlite',
      '003_add_broker-0123456789abcdef.sqlite.lock',
      'pid4183-ns4026531836-003_add_broker-0123456789abcdef.sqlite',
      basename(template),
    ].toSorted(),
  );
});

test('it builds the template when a killed run left its lock', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  rmSync(template);
  writeFileSync(`${template}.lock`, 'pid4183-ns4026531836');

  await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: (pid) => pid !== 4183,
  });

  expect(existsSync(template)).toBeTrue();
});

test('it builds the template when a lock is older than 30 s, whatever its owner', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  rmSync(template);
  writeFileSync(`${template}.lock`, '');

  await createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', {
    ...ctx.dependencies,
    now: () => Date.now() + 60_000,
  });

  expect(existsSync(template)).toBeTrue();
});

test('it waits for the template that a running build holds the lock for', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  rmSync(template);
  writeFileSync(`${template}.lock`, 'pid4183-ns4026531836');

  const waited = createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', ctx.dependencies);

  writeFileSync(template, 'built by the run that holds the lock');

  await waited;

  expect(readFileSync(template, 'utf8')).toBe('built by the run that holds the lock');
});

test('it leaves a fresh lock of another PID namespace whose PID is not running here', async () => {
  const ctx = setupTest();

  const template = await createMigratedTemplate(
    ctx.cacheDirectory,
    '003_add_broker',
    ctx.dependencies,
  );

  rmSync(template);
  writeFileSync(`${template}.lock`, 'pid4183-ns4026532001');

  const waited = createMigratedTemplate(ctx.cacheDirectory, '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: () => false,
  });

  writeFileSync(template, 'built in another sandbox');

  await waited;

  expect(readFileSync(`${template}.lock`, 'utf8')).toBe('pid4183-ns4026532001');
});
