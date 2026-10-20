import { expect, onTestFinished, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listTree } from './list-tree';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'list-tree-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it marks directories, symlinks and executable files in sorted order', async () => {
  const ctx = await setupTest();

  await mkdir(join(ctx.directoryPath, 'sub'));
  await writeFile(join(ctx.directoryPath, 'sub', 'b.txt'), '');
  await writeFile(join(ctx.directoryPath, 'run'), '');
  await chmod(join(ctx.directoryPath, 'run'), 0o755);
  await symlink('run', join(ctx.directoryPath, 'start'));

  const tree = await listTree(ctx.directoryPath);

  expect(tree).toStrictEqual(['run*', 'start@', 'sub/', 'sub/b.txt']);
});

test('it lists nothing for an empty directory', async () => {
  const ctx = await setupTest();
  const tree = await listTree(ctx.directoryPath);

  expect(tree).toStrictEqual([]);
});
