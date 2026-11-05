import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countChangedPages, readChangedPages } from './count-changed-pages';
import { wireChangedPagesFS } from './wire-changed-pages-fs';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'changed-pages-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directory, fs: wireChangedPagesFS() };
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

  const changed = readChangedPages(ctx.fs, join(ctx.directory, 'base'), join(ctx.directory, 'mem'));

  expect(changed).toStrictEqual({ pages: 4, hugePages: 3 });
});

test('it refuses a snapshot that is not there, and closes the base it opened', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'base'), new Uint8Array(4096));

  const close = mock<(file: number) => void>((file) => {
    ctx.fs.close(file);
  });

  expect(() =>
    readChangedPages({ ...ctx.fs, close }, join(ctx.directory, 'base'), join(ctx.directory, 'mem')),
  ).toThrow(/ENOENT/u);

  expect(close).toHaveBeenCalledOnce();
});

test('it fails with the read error when the close after it fails too', () => {
  expect(() =>
    readChangedPages(
      {
        open: () => 7,
        readSize: () => 4096,
        read: () => {
          throw new Error('EIO: i/o error, read');
        },
        close: () => {
          throw new Error('EBADF: bad file descriptor, close');
        },
      },
      '/var/lib/imp/touched-pages-base',
      '/var/lib/imp/imps/imp_1/snapshot/mem',
    ),
  ).toThrowWithMessage(Error, 'EIO: i/o error, read');
});

test('it fails with the read error and closes both files when a read fails', async () => {
  const ctx = await setupTest();

  await writeFile(join(ctx.directory, 'base'), new Uint8Array(4096));
  await writeFile(join(ctx.directory, 'mem'), new Uint8Array(4096));

  const close = mock<(file: number) => void>((file) => {
    ctx.fs.close(file);
  });

  expect(() =>
    readChangedPages(
      {
        ...ctx.fs,
        read: () => {
          throw new Error('EIO: i/o error, read');
        },
        close,
      },
      join(ctx.directory, 'base'),
      join(ctx.directory, 'mem'),
    ),
  ).toThrowWithMessage(Error, 'EIO: i/o error, read');

  expect(close).toHaveBeenCalledTimes(2);
});
