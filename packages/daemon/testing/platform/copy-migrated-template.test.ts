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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubAnswerQueue } from '@impz/test-utils/build-stub-answer-queue';
import { buildStubTemplateWriter } from './build-stub-template-writer';
import { copyMigratedTemplate } from './copy-migrated-template';
import { formatRunPrefix } from './format-run-prefix';
import { readRunOwner } from './read-run-owner';

function setupTest() {
  const prefix = formatRunPrefix(readRunOwner());
  const directory = mkdtempSync(join(tmpdir(), `${prefix}imp-template-`));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const cacheDirectory = join(directory, 'cache');
  const buildIDs = buildStubAnswerQueue(['3f2a', '4c1b', '5d0c', '6e9d']);

  const dependencies = {
    cacheDirectory,
    migrationsHash: '0123456789abcdef',
    owner: { pid: 4182, namespace: '4026531836' },

    // before every real file time, so only a time that a test sets ages a file
    now: () => 1_000_000_000_000,
    createBuildID: () => buildIDs.next(),
    probeProcessRunning: () => true,
    fileSystem: {
      copyFileSync,
      existsSync,
      mkdirSync,
      readdirSync,
      renameSync,
      rmSync,
      statSync,
      writeFileSync,
    },
    writeTemplate: buildStubTemplateWriter({ contents: 'a migrated template' }).writeTemplate,
  };

  return { directory, cacheDirectory, dependencies };
}

test('it copies the template it builds to the path', async () => {
  const ctx = setupTest();

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies);

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe('a migrated template');
});

test('it reuses the template it built on the next call', async () => {
  const ctx = setupTest();
  const writer = buildStubTemplateWriter({ contents: 'a migrated template' });
  const dependencies = { ...ctx.dependencies, writeTemplate: writer.writeTemplate };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);
  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', dependencies);

  expect(writer.builds).toHaveLength(1);
});

test('it builds a fresh template when the migrations change under the same name', async () => {
  const ctx = setupTest();
  const writer = buildStubTemplateWriter({ contents: 'a migrated template' });
  const dependencies = { ...ctx.dependencies, writeTemplate: writer.writeTemplate };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', {
    ...dependencies,
    migrationsHash: 'fedcba9876543210',
  });

  expect(writer.builds).toHaveLength(2);
});

test('it gives a call that starts during another build a whole copy', async () => {
  const ctx = setupTest();
  const release = Promise.withResolvers<void>();

  const dependencies = {
    ...ctx.dependencies,
    writeTemplate: buildStubTemplateWriter({
      contents: 'a migrated template',
      pause: { partial: 'half a template', release: release.promise },
    }).writeTemplate,
  };

  // the first call stops after its partial write, before the second starts
  const first = copyMigratedTemplate(
    join(ctx.directory, 'first.sqlite'),
    '003_add_broker',
    dependencies,
  );

  const second = copyMigratedTemplate(
    join(ctx.directory, 'second.sqlite'),
    '003_add_broker',
    dependencies,
  );

  release.resolve();

  await Promise.all([first, second]);

  expect([
    readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8'),
    readFileSync(join(ctx.directory, 'second.sqlite'), 'utf8'),
  ]).toStrictEqual(['a migrated template', 'a migrated template']);
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
  const writer = buildStubTemplateWriter({ contents: 'a migrated template' });
  const dependencies = { ...ctx.dependencies, writeTemplate: writer.writeTemplate };

  await copyMigratedTemplate(join(ctx.directory, 'first.sqlite'), '003_add_broker', dependencies);

  rmSync(join(ctx.cacheDirectory, '003_add_broker-0123456789abcdef.sqlite'));

  await copyMigratedTemplate(join(ctx.directory, 'second.sqlite'), '003_add_broker', dependencies);

  expect(writer.builds).toHaveLength(2);
});

test('it removes the files of older migrations over an hour old when it builds one', async () => {
  const ctx = setupTest();

  const twoHoursBefore = new Date(999_992_800_000);

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');

  utimesSync(
    join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'),
    twoHoursBefore,
    twoHoursBefore,
  );

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  utimesSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    twoHoursBefore,
    twoHoursBefore,
  );

  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', ctx.dependencies);

  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual(['003_add_broker-0123456789abcdef.sqlite']);
});

test('it keeps a template of older migrations built within the hour and a running build', async () => {
  const ctx = setupTest();

  const aMinuteBefore = new Date(999_999_940_000);

  mkdirSync(ctx.cacheDirectory);
  writeFileSync(join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'), '');

  utimesSync(
    join(ctx.cacheDirectory, '003_add_broker-fedcba9876543210.sqlite'),
    aMinuteBefore,
    aMinuteBefore,
  );

  writeFileSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    '',
  );

  utimesSync(
    join(ctx.cacheDirectory, 'pid4183-ns4026531836-3f2a-003_add_broker-fedcba9876543210.sqlite'),
    aMinuteBefore,
    aMinuteBefore,
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

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe('a migrated template');
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

  // the listing names a build file that left before the sweep reads its times
  await copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    fileSystem: {
      ...ctx.dependencies.fileSystem,
      readdirSync: () => [
        '003_add_broker-0123456789abcdef.sqlite',
        'pid4183-ns4026531836-7a7a-003_add_broker-fedcba9876543210.sqlite',
      ],
    },
  });

  expect(readFileSync(join(ctx.directory, 'imp.sqlite'), 'utf8')).toBe('a migrated template');
});

test('it leaves no build file when the build fails', () => {
  const ctx = setupTest();

  const copied = copyMigratedTemplate(join(ctx.directory, 'imp.sqlite'), '003_add_broker', {
    ...ctx.dependencies,
    writeTemplate: buildStubTemplateWriter({
      contents: 'half a template',
      failure: new Error('the disk went away'),
    }).writeTemplate,
  });

  expect(copied).rejects.toThrow('the disk went away');
  expect(readdirSync(ctx.cacheDirectory)).toStrictEqual([]);
});

test('it fails a build whose build ID another build holds, and leaves that build whole', async () => {
  const ctx = setupTest();
  const release = Promise.withResolvers<void>();
  const buildIDs = buildStubAnswerQueue(['3f2a', '3f2a']);

  const dependencies = {
    ...ctx.dependencies,
    createBuildID: () => buildIDs.next(),
    writeTemplate: buildStubTemplateWriter({
      contents: 'a migrated template',
      pause: { partial: 'half a template', release: release.promise },
    }).writeTemplate,
  };

  // the first call stops after its partial write, before the second starts
  const first = copyMigratedTemplate(
    join(ctx.directory, 'first.sqlite'),
    '003_add_broker',
    dependencies,
  );

  const second = copyMigratedTemplate(
    join(ctx.directory, 'second.sqlite'),
    '003_add_broker',
    dependencies,
  );

  release.resolve();

  await first;

  expect(second).rejects.toThrow('EEXIST');
  expect(readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8')).toBe('a migrated template');
});
