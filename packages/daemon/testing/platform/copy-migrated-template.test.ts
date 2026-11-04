import { expect, onTestFinished, test } from 'bun:test';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { copyMigratedTemplate } from './copy-migrated-template';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-template-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const cacheDirectory = join(directory, 'cache');

  const dependencies = {
    cacheDirectory,
    migrationsHash: '0123456789abcdef',
    owner: { pid: 4182, namespace: '4026531836' },
    now: Date.now,
    probeProcessRunning: () => true,
    fileSystem: { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync },
    writeTemplate: (path: string, migration: string) => {
      writeFileSync(path, `migrated to ${migration}`);

      return Promise.resolve();
    },
  };

  return { directory, cacheDirectory, dependencies };
}

test('it copies the template it builds to the path', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies);

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe(
    'migrated to 003_add_broker',
  );
});

test('it reuses the template it built on the next call', async () => {
  const ctx = setupTest();
  const builds: string[] = [];

  const dependencies = {
    ...ctx.dependencies,
    writeTemplate: (path: string) => {
      builds.push(path);

      writeFileSync(path, 'a migrated template');

      return Promise.resolve();
    },
  };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);
  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', dependencies);

  expect(builds).toHaveLength(1);
});

test('it builds a fresh template when the migrations change under the same name', async () => {
  const ctx = setupTest();
  const builds: string[] = [];

  const dependencies = {
    ...ctx.dependencies,
    writeTemplate: (path: string) => {
      builds.push(path);

      writeFileSync(path, 'a migrated template');

      return Promise.resolve();
    },
  };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', {
    ...dependencies,
    migrationsHash: 'fedcba9876543210',
  });

  expect(builds).toHaveLength(2);
});

test('it gives each of two racing calls a whole copy', async () => {
  const ctx = setupTest();

  await Promise.all([
    copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', ctx.dependencies),
    copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', ctx.dependencies),
  ]);

  expect([
    readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8'),
    readFileSync(join(ctx.directory, 'second.sqlite'), 'utf8'),
  ]).toStrictEqual(['migrated to 003_add_broker', 'migrated to 003_add_broker']);
});

test('it throws when the destination folder does not exist', () => {
  const ctx = setupTest();

  expect(
    copyMigratedTemplate(
      join(ctx.directory, 'missing', 'imp.sqlite'),
      '003_add_broker',
      ctx.dependencies,
    ),
  ).rejects.toThrow('ENOENT');
});

test('it builds the template that a sweep removed', async () => {
  const ctx = setupTest();
  const builds: string[] = [];

  const dependencies = {
    ...ctx.dependencies,
    writeTemplate: (path: string) => {
      builds.push(path);

      writeFileSync(path, 'a migrated template');

      return Promise.resolve();
    },
  };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);

  rmSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'));

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', dependencies);

  expect(builds).toHaveLength(2);
});

test('it removes the files of older migrations over an hour old when it builds one', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    now: () => Date.now() + 7_200_000,
  });

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual(['003_add_broker-0123456789abcdef.sqlite']);
});

test('it keeps a template of older migrations built within the hour and a running build', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies);

  expect(readdirSync(ctx.cacheDirectory).toSorted()).toStrictEqual([
    '003_add_broker-0123456789abcdef.sqlite',
    '003_add_broker-fedcba9876543210.sqlite',
    'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite',
  ]);
});

test('it removes the build file of a run whose process is gone when it builds one', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-0123456789abcdef.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: (pid) => pid !== 4183,
  });

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual(['003_add_broker-0123456789abcdef.sqlite']);
});

test('it keeps the build file of another PID namespace whose PID is not running here', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026532001-3f2a-003_add_broker-0123456789abcdef.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: () => false,
  });

  expect(readdirSync(ctx.cacheDirectory).toSorted()).toStrictEqual([
    '003_add_broker-0123456789abcdef.sqlite',
    'pid4183-ns4026532001-3f2a-003_add_broker-0123456789abcdef.sqlite',
  ]);
});

test('it builds the template again when a sweep removes it between the check and the copy', async () => {
  const ctx = setupTest();

  // present at the check, gone at the copy and after it, then built and copied
  const templateChecks = buildStubAnswerQueue([true, false, false, true, true]);

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    fileSystem: { ...ctx.dependencies.fileSystem, existsSync: () => templateChecks.next() },
  });

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe(
    'migrated to 003_add_broker',
  );
});

test('it throws when the destination links to a missing path', () => {
  const ctx = setupTest();

  symlinkSync(join(ctx.directory, 'missing', 'imp.sqlite'), join(ctx.directory, 'imp.sqlite'));

  expect(
    copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies),
  ).rejects.toThrow('ENOENT');
});

test('it skips a file that leaves the cache while it sweeps', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    fileSystem: {
      ...ctx.dependencies.fileSystem,
      readdirSync: () => [
        '003_add_broker-0123456789abcdef.sqlite',
        'pid4183-ns4026531836-3f2a-003_add_broker-0123456789abcdef.sqlite',
      ],
    },
  });

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe(
    'migrated to 003_add_broker',
  );
});

test('it leaves no build file when the build fails', () => {
  const ctx = setupTest();

  const copied = copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    writeTemplate: (path) => {
      writeFileSync(path, 'half a template');

      return Promise.reject(new Error('the disk went away'));
    },
  });

  expect(copied).rejects.toThrow('the disk went away');
  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual([]);
});
