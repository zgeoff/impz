import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubWideDir } from './build-stub-wide-dir';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-wide-dir-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it lists the real entries of the wide directory, then the generated subdirectories', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'opt'));
  writeFileSync(join(ctx.directoryPath, 'issue'), 'welcome');

  const entries = await buildStubWideDir(ctx.directoryPath, 3).readDir(ctx.directoryPath);

  expect(
    entries.map((entry) => ({
      name: entry.name,
      parentPath: entry.parentPath,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
      isSymbolicLink: entry.isSymbolicLink(),
    })),
  ).toIncludeSameMembers([
    {
      name: 'opt',
      parentPath: ctx.directoryPath,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    },
    {
      name: 'issue',
      parentPath: ctx.directoryPath,
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
    },
    {
      name: 'sub-0',
      parentPath: ctx.directoryPath,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    },
    {
      name: 'sub-1',
      parentPath: ctx.directoryPath,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    },
    {
      name: 'sub-2',
      parentPath: ctx.directoryPath,
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
    },
  ]);
});

test('it lists a generated subdirectory as empty', async () => {
  const ctx = await setupTest();

  expect(
    buildStubWideDir(ctx.directoryPath, 3).readDir(join(ctx.directoryPath, 'sub-2')),
  ).resolves.toStrictEqual([]);
});

test('it lists any other directory as readdir does', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'opt', 'tools'), { recursive: true });

  const entries = await buildStubWideDir(ctx.directoryPath, 3).readDir(
    join(ctx.directoryPath, 'opt'),
  );

  expect(entries.map((entry) => entry.name)).toStrictEqual(['tools']);
});

test('it rejects a name that only looks generated as readdir does', async () => {
  const ctx = await setupTest();

  expect(
    buildStubWideDir(ctx.directoryPath, 3).readDir(join(ctx.directoryPath, 'sub-01')),
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('it rejects a directory past the generated range as readdir does', async () => {
  const ctx = await setupTest();

  expect(
    buildStubWideDir(ctx.directoryPath, 3).readDir(join(ctx.directoryPath, 'sub-3')),
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
