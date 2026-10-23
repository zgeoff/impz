import { expect, test } from 'bun:test';
import { hasVdevLine } from './has-vdev-line.ts';

test('it finds the vdev on a line of zpool status -P', () => {
  expect(
    hasVdevLine(
      '  pool: tank\n config:\n\n\ttank                ONLINE  0 0 0\n\t  /var/tmp/w/pool.img  ONLINE  0 0 0\n',
      '/var/tmp/w/pool.img',
    ),
  ).toBeTrue();
});

test('it finds a vdev whose path holds spaces', () => {
  expect(
    hasVdevLine('\t  /var/tmp/work dir/pool.img  ONLINE  0 0 0\n', '/var/tmp/work dir/pool.img'),
  ).toBeTrue();
});

test('it finds a vdev whose path holds a state word', () => {
  expect(
    hasVdevLine(
      '\t  /var/tmp/w  ONLINE d/pool.img  DEGRADED  0 0 0\n',
      '/var/tmp/w  ONLINE d/pool.img',
    ),
  ).toBeTrue();
});

test('it finds a vdev at the end of a line with no counts', () => {
  expect(hasVdevLine('\t  /var/tmp/w/pool.img  UNAVAIL', '/var/tmp/w/pool.img')).toBeTrue();
});

test('it ignores a vdev whose path only starts with the file', () => {
  expect(
    hasVdevLine('\t  /var/tmp/w/pool.img old  ONLINE  0 0 0\n', '/var/tmp/w/pool.img'),
  ).toBeFalse();
});

test('it ignores the path followed by one blank only', () => {
  expect(hasVdevLine('\t  /var/tmp/w/pool.img ONLINE  0 0 0\n', '/var/tmp/w/pool.img')).toBeFalse();
});

test('it ignores the path followed by a word that is no state', () => {
  expect(
    hasVdevLine('\t  /var/tmp/w/pool.img  ONLINEISH  0 0 0\n', '/var/tmp/w/pool.img'),
  ).toBeFalse();
});

test('it finds nothing in status output without the vdev', () => {
  expect(
    hasVdevLine('  pool: tank\n\t  /dev/sdb  ONLINE  0 0 0\n', '/var/tmp/w/pool.img'),
  ).toBeFalse();
});
