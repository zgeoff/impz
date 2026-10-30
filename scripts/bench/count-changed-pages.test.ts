import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countChangedPages, readChangedPages } from './count-changed-pages';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'changed-pages-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory };
}

test('it counts each changed 4 KiB page, and each 2 MiB page that holds one', () => {
  const base = new Uint8Array(3 * 2 * 1024 * 1024);

  const next = Uint8Array.from(base);

  next[0] = 1;
  next[4095] = 1;
  next[4096] = 1;
  next[2 * 2 * 1024 * 1024 + 10] = 7;

  expect(countChangedPages(base, next)).toStrictEqual({ pages: 3, hugePages: 2 });
});

test('it counts nothing when the snapshot holds the same bytes as its base', () => {
  const base = new Uint8Array(2 * 1024 * 1024).fill(9);

  expect(countChangedPages(base, Uint8Array.from(base))).toStrictEqual({
    pages: 0,
    hugePages: 0,
  });
});

test('it reads the part of a longer snapshot past its base as changed only where it holds data', () => {
  const base = new Uint8Array(4096);
  const next = new Uint8Array(3 * 4096);

  next[2 * 4096] = 5;

  expect(countChangedPages(base, next)).toStrictEqual({ pages: 1, hugePages: 1 });
});

test('it counts the changed pages of two files across every 2 MiB chunk they hold', async () => {
  const ctx = await setupTest();

  const base = new Uint8Array(5 * 1024 * 1024);

  const next = Uint8Array.from(base);

  next[10] = 1;
  next[2 * 1024 * 1024 + 4096] = 1;
  next[4 * 1024 * 1024 + 8192] = 1;
  next[5 * 1024 * 1024 - 1] = 1;

  await writeFile(join(ctx.directory, 'base'), base);
  await writeFile(join(ctx.directory, 'mem'), next);

  expect(readChangedPages(join(ctx.directory, 'base'), join(ctx.directory, 'mem'))).toStrictEqual({
    pages: 4,
    hugePages: 3,
  });
});

test('it refuses a snapshot that is not there', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'base'), new Uint8Array(4096));

  expect(() => readChangedPages(join(ctx.directory, 'base'), join(ctx.directory, 'mem'))).toThrow(
    /ENOENT/u,
  );
});
