import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText } from '../../../scripts/lib/read-text.ts';
import { REPO_ROOT } from './instance';
import { readPoolProperties } from './read-pool-properties';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-pool-properties-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it reads each -o word as a zpool property and each -O word as a zfs one', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"create": ["-o", "ashift=12", "-O", "compression=lz4", "-O", "a=b=c"]}');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'read',
    properties: [
      { tool: 'zpool', name: 'ashift', value: '12' },
      { tool: 'zfs', name: 'compression', value: 'lz4' },
      { tool: 'zfs', name: 'a', value: 'b=c' },
    ],
  });
});

test('it reads the properties deploy/zfs-pool.json gives', () => {
  const read = readPoolProperties(join(REPO_ROOT, 'deploy', 'zfs-pool.json'), readText);

  if (read.kind !== 'read') {
    throw new Error(read.reason);
  }

  expect(read.properties).not.toBeEmpty();
});

test('it refuses a file that is missing', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'missing.json');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: expect.toStartWith(`cannot read the pool properties from ${path}: `),
  });
});

test('it refuses a file that is not JSON', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"create": [');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: expect.toStartWith('deploy/zfs-pool.json: '),
  });
});

test('it refuses a file with no create list', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"properties": ["-o", "ashift=12"]}');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: expect.toStartWith('deploy/zfs-pool.json: '),
  });
});

test('it refuses a file that gives no properties', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"create": []}');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: expect.toInclude('gives zpool create no properties'),
  });
});

test('it refuses a word that is neither -o nor -O', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"create": ["-o", "ashift=12", "-f", "force=1"]}');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: `${path} gives zpool create -f force=1, not -o or -O name=value`,
  });
});

test('it refuses a flag with no property after it', () => {
  const ctx = setupTest();
  const path = join(ctx.directory, 'zfs-pool.json');

  writeFileSync(path, '{"create": ["-o"]}');

  expect(readPoolProperties(path, readText)).toStrictEqual({
    kind: 'refused',
    reason: `${path} gives zpool create -o , not -o or -O name=value`,
  });
});
