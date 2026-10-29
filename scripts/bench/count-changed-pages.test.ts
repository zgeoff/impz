import { expect, test } from 'bun:test';
import { countChangedPages } from './count-changed-pages';

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
