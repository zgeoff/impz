import { expect, test } from 'bun:test';
import { parseZfsPool } from './parse-zfs-pool.ts';

test('it reads the create words', () => {
  expect(parseZfsPool('{"create": ["-o", "ashift=12", "-O", "xattr=sa"]}')).toStrictEqual([
    '-o',
    'ashift=12',
    '-O',
    'xattr=sa',
  ]);
});

test('it refuses a word the shell would split or expand', () => {
  expect(() => parseZfsPool('{"create": ["-O", "comment=two words"]}')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: .*is not a plain word/su,
  );
});

test('it refuses a file that gives zpool create no properties', () => {
  expect(() => parseZfsPool('{"create": []}')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: .*gives zpool create no properties/su,
  );
});

test('it refuses a file with no create list', () => {
  expect(() => parseZfsPool('{}')).toThrowWithMessage(Error, /^deploy\/zfs-pool\.json: .*create/su);
});

test('it refuses a file that is not JSON', () => {
  expect(() => parseZfsPool('create: [-o]')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: /u,
  );
});
