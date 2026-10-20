import { expect, onTestFinished, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTreeTar } from './create-tree-tar';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'tree-tar-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it archives the tree make writes from its root', async () => {
  const ctx = await setupTest();

  const tar = createTreeTar(ctx.directoryPath, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('./\n./hello\n');
});

test('it owns each entry by root', async () => {
  const ctx = await setupTest();

  const tar = createTreeTar(ctx.directoryPath, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const listed = Bun.spawnSync(['tar', '-t', '-v', '--numeric-owner', '-f', '-'], {
    stdin: tar,
  }).stdout.toString();

  expect(listed.trimEnd().split('\n')).toSatisfyAll((line: string) => line.includes(' 0/0 '));
});

test('it passes its tar arguments to tar', async () => {
  const ctx = await setupTest();

  const tar = createTreeTar(
    ctx.directoryPath,
    (tree) => {
      writeFileSync(join(tree, 'kept'), 'k\n');
      writeFileSync(join(tree, 'skipped'), 's\n');
    },
    ['--exclude=./skipped'],
  );

  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('./\n./kept\n');
});

test('it throws with tar exit code and stderr when tar fails', async () => {
  const ctx = await setupTest();

  expect(() =>
    createTreeTar(
      ctx.directoryPath,
      (tree) => {
        writeFileSync(join(tree, 'hello'), 'hi\n');
      },
      ['--no-such-option'],
    ),
  ).toThrowWithMessage(Error, /^tar exited 64: tar: unrecognized option '--no-such-option'/v);
});

test('it removes the tree when tar fails', async () => {
  const ctx = await setupTest();

  expect(() =>
    createTreeTar(
      ctx.directoryPath,
      (tree) => {
        writeFileSync(join(tree, 'hello'), 'hi\n');
      },
      ['--no-such-option'],
    ),
  ).toThrow();

  const left = await readdir(ctx.directoryPath);

  expect(left).toStrictEqual([]);
});

test('it removes the tree once it is archived', async () => {
  const ctx = await setupTest();

  createTreeTar(ctx.directoryPath, (tree) => {
    writeFileSync(join(tree, 'hello'), 'hi\n');
  });

  const left = await readdir(ctx.directoryPath);

  expect(left).toStrictEqual([]);
});
