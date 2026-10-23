import { expect, test } from 'bun:test';
import { parseZfsPoolProperties } from './parse-zfs-pool-properties.ts';

test('it reads the create words', () => {
  expect(parseZfsPoolProperties('{"create": ["-o", "ashift=12", "-O", "xattr=sa"]}')).toStrictEqual(
    ['-o', 'ashift=12', '-O', 'xattr=sa'],
  );
});

test('it refuses a word the shell would split or expand', () => {
  expect(() =>
    parseZfsPoolProperties('{"create": ["-O", "comment=two words"]}'),
  ).toThrowWithMessage(Error, /^deploy\/zfs-pool\.json: .*is not a plain word/su);
});

test('it refuses a file that gives zpool create no properties', () => {
  expect(() => parseZfsPoolProperties('{"create": []}')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: .*gives zpool create no properties/su,
  );
});

test('it refuses a file with no create list', () => {
  expect(() => parseZfsPoolProperties('{}')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: .*create/su,
  );
});

test('it refuses a file that is not JSON', () => {
  expect(() => parseZfsPoolProperties('create: [-o]')).toThrowWithMessage(
    Error,
    /^deploy\/zfs-pool\.json: /u,
  );
});
