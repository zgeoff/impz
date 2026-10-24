import { expect, test } from 'bun:test';
import { createContentHash } from './create-content-hash';

test('it sums the same file sent with its zero block as data and as a hole alike', () => {
  const withZeros = createContentHash(3 * 1024 * 1024);
  const withHole = createContentHash(3 * 1024 * 1024);

  withZeros.update(0, Buffer.from('rootfs'));
  withZeros.update(1024 * 1024, Buffer.alloc(1024 * 1024));
  withHole.update(0, Buffer.from('rootfs'));

  expect(withZeros.digest()).toBe(withHole.digest());
});

test('it sums two files that differ only in size apart', () => {
  const short = createContentHash(1024 * 1024);
  const long = createContentHash(3 * 1024 * 1024);

  short.update(0, Buffer.from('rootfs'));
  long.update(0, Buffer.from('rootfs'));

  expect(short.digest()).not.toBe(long.digest());
});

test('it sums two files that differ only in the place of their data apart', () => {
  const first = createContentHash(3 * 1024 * 1024);
  const second = createContentHash(3 * 1024 * 1024);

  first.update(0, Buffer.from('rootfs'));
  second.update(1024 * 1024, Buffer.from('rootfs'));

  expect(first.digest()).not.toBe(second.digest());
});

test('it sums a piece that holds the bytes of a second piece’s place apart from the two pieces', () => {
  const place = Buffer.alloc(16);

  place.writeBigUInt64BE(8n, 0);
  place.writeBigUInt64BE(2n, 8);

  const joined = createContentHash(64);
  const split = createContentHash(64);

  joined.update(0, Buffer.concat([Buffer.from('ab'), place, Buffer.from('cd')]));
  split.update(0, Buffer.from('ab'));
  split.update(8, Buffer.from('cd'));

  expect(joined.digest()).not.toBe(split.digest());
});

test('it sums a block with one byte set past its zeros as data', () => {
  const block = Buffer.alloc(1024 * 1024);
  const empty = createContentHash(1024 * 1024);
  const written = createContentHash(1024 * 1024);

  block[block.length - 1] = 1;

  written.update(0, block);

  expect(written.digest()).not.toBe(empty.digest());
});
