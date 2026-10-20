import { expect, onTestFinished, test } from 'bun:test';
import { linkSync, mkdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubWideDir } from '../../testing/vm/build-stub-wide-dir';
import { countTreeBytes } from './count-tree-bytes';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'imp-tree-bytes-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it counts the blocks of every file in the tree, less a 512-byte block each', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.directoryPath, 'etc', 'apt'), { recursive: true });
  writeFileSync(join(ctx.directoryPath, 'motd'), 'x'.repeat(10_000));
  writeFileSync(join(ctx.directoryPath, 'etc', 'apt', 'sources.list'), 'y'.repeat(70_000));

  const motd = statSync(join(ctx.directoryPath, 'motd')).blocks * 512;
  const sources = statSync(join(ctx.directoryPath, 'etc', 'apt', 'sources.list')).blocks * 512;

  expect(motd).toBeGreaterThanOrEqual(10_000);
  expect(sources).toBeGreaterThanOrEqual(70_000);
  expect(countTreeBytes(ctx.directoryPath)).resolves.toBe(motd + sources - 2 * 512);
});

test('it counts an empty file as 0', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'empty'), '');

  expect(countTreeBytes(ctx.directoryPath)).resolves.toBe(0);
});

test('it counts a hard-linked file once', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'busybox'), 'z'.repeat(50_000));
  linkSync(join(ctx.directoryPath, 'busybox'), join(ctx.directoryPath, 'sh'));

  expect(countTreeBytes(ctx.directoryPath)).resolves.toBe(
    statSync(join(ctx.directoryPath, 'busybox')).blocks * 512 - 512,
  );
});

test('it never counts the target of a symlink', async () => {
  const ctx = await setupTest();
  const outside = await mkdtemp(join(tmpdir(), 'imp-tree-bytes-outside-'));

  onTestFinished(() => rm(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'big'), 'w'.repeat(200_000));
  mkdirSync(join(ctx.directoryPath, 'tree'));
  symlinkSync(join(outside, 'big'), join(ctx.directoryPath, 'tree', 'big'));
  symlinkSync(outside, join(ctx.directoryPath, 'tree', 'elsewhere'));

  expect(countTreeBytes(join(ctx.directoryPath, 'tree'))).resolves.toBe(0);
});

test('it counts a tree with 700,000 sibling directories', async () => {
  const ctx = await setupTest();

  writeFileSync(join(ctx.directoryPath, 'hostname'), 'v'.repeat(20_000));

  const wide = buildStubWideDir(ctx.directoryPath, 700_000);

  expect(countTreeBytes(ctx.directoryPath, { readDir: wide.readDir })).resolves.toBe(
    statSync(join(ctx.directoryPath, 'hostname')).blocks * 512 - 512,
  );
});

test('it counts a tree that does not exist yet as 0', async () => {
  const ctx = await setupTest();

  expect(countTreeBytes(join(ctx.directoryPath, 'root'))).resolves.toBe(0);
});
