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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { copyMigratedTemplate } from './copy-migrated-template';
import type { TemplateDependencies } from './copy-migrated-template';

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
    sleep: () => setImmediate(),
    probeProcessRunning: () => true,
    fileSystem: {
      copyFileSync,
      existsSync,
      mkdirSync,
      readFileSync,
      readdirSync,
      renameSync,
      rmSync,
      statSync,
      utimesSync,
      writeFileSync,
    },
    writeTemplate: (path: string) => {
      writeFileSync(path, 'a migrated template');

      return Promise.resolve();
    },
  };

  return {
    directory,
    cacheDirectory,
    template: join(cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'),
    dependencies,
  };
}

test('it copies the template it builds to the path', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    writeTemplate: (path, migration) => {
      writeFileSync(path, `migrated to ${migration}`);

      return Promise.resolve();
    },
  });

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

test('it builds the template once when two calls race for the lock', async () => {
  const ctx = setupTest();
  const builds: string[] = [];
  const lostRace = Promise.withResolvers<void>();

  const dependencies: TemplateDependencies = {
    ...ctx.dependencies,

    // both calls read the cache before either takes the lock
    fileSystem: {
      ...ctx.dependencies.fileSystem,
      existsSync: (path) => !String(path).endsWith('.lock') && existsSync(path),
    },
    sleep: () => {
      lostRace.resolve();

      return setImmediate();
    },
    writeTemplate: async (path) => {
      builds.push(path);

      await lostRace.promise;

      writeFileSync(path, 'a migrated template');
    },
  };

  await Promise.all([
    copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies),
    copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', dependencies),
  ]);

  expect(builds).toHaveLength(1);
});

test('it builds the template again when a sweep removes it before the copy', async () => {
  const ctx = setupTest();
  const builds: string[] = [];

  const dependencies = {
    ...ctx.dependencies,
    writeTemplate: (path: string) => {
      builds.push(path);

      writeFileSync(path, `build ${String(builds.length)}`);

      return Promise.resolve();
    },
  };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', {
    ...dependencies,
    fileSystem: {
      ...dependencies.fileSystem,
      utimesSync: (path, accessed, modified) => {
        utimesSync(path, accessed, modified);

        if (builds.length === 1) {
          rmSync(path);
        }
      },
    },
  });

  expect(readFileSync(join(ctx.directory, 'second.sqlite'), 'utf8')).toBe('build 2');
});

test('it marks the template as used on each call', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(
    join(ctx.directory, 'first.sqlite'),
    '003_add_broker',
    ctx.dependencies,
  );

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    now: () => 1_800_000_000_000,
  });

  expect(statSync(ctx.template).mtimeMs).toBe(1_800_000_000_000);
});

test('it removes the files of older migrations unused for an hour when it builds one', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite.lock'), '');

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4182-ns4026531836-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    now: () => Date.now() + 7_200_000,
  });

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual(['003_add_broker-0123456789abcdef.sqlite']);
});

test('it keeps the files of older migrations that a running build holds', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');

  writeFileSync(
    join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite.lock'),
    'pid4183-ns4026531836',
  );

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies);

  expect(readdirSync(ctx.cacheDirectory).toSorted()).toStrictEqual([
    '003_add_broker-0123456789abcdef.sqlite',
    '003_add_broker-fedcba9876543210.sqlite',
    '003_add_broker-fedcba9876543210.sqlite.lock',
    'pid4183-ns4026531836-003_add_broker-fedcba9876543210.sqlite',
  ]);
});

test('it builds the template when a killed run left its lock', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(`${ctx.template}.lock`, 'pid4183-ns4026531836');

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: (pid) => pid !== 4183,
  });

  expect(existsSync(ctx.template)).toBeTrue();
});

test('it builds the template when a lock is older than 30 s, whatever its owner', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(`${ctx.template}.lock`, '');

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    now: () => Date.now() + 60_000,
  });

  expect(existsSync(ctx.template)).toBeTrue();
});

test('it waits for the template that a running build holds the lock for', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(`${ctx.template}.lock`, 'pid4183-ns4026531836');

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    sleep: () => {
      writeFileSync(ctx.template, 'built by the run that holds the lock');

      return Promise.resolve();
    },
  });

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe(
    'built by the run that holds the lock',
  );
});

test('it leaves a fresh lock of another PID namespace whose PID is not running here', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(`${ctx.template}.lock`, 'pid4183-ns4026532001');

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: () => false,
    sleep: () => {
      writeFileSync(ctx.template, 'built in another sandbox');

      return Promise.resolve();
    },
  });

  expect(readFileSync(`${ctx.template}.lock`, 'utf8')).toBe('pid4183-ns4026532001');
});

test('it removes the build file of a run whose process is gone when it builds one', async () => {
  const ctx = setupTest();

  mkdirSync(ctx.cacheDirectory);

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-003_add_broker-0123456789abcdef.sqlite'),
    '',
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    probeProcessRunning: (pid) => pid !== 4183,
  });

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual(['003_add_broker-0123456789abcdef.sqlite']);
});
