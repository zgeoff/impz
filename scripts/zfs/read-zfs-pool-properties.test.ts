import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevError } from '../lib/dev-error.ts';
import { readZfsPoolProperties } from './read-zfs-pool-properties.ts';
import { wireZfsIO } from './wire-zfs-io.ts';

function setupTest() {
  const root = mkdtempSync(join(tmpdir(), 'imp-zfs-pool-'));

  onTestFinished(() => {
    rmSync(root, { recursive: true, force: true });
  });

  mkdirSync(join(root, 'deploy'));

  return { root, files: wireZfsIO().files };
}

test('it reads the properties the pool file gives', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'deploy', 'zfs-pool.json'), '{"create": ["-O", "atime=off"]}');

  expect(readZfsPoolProperties(ctx.files, ctx.root)).toStrictEqual(['-O', 'atime=off']);
});

test('it fails when the pool file is missing', () => {
  const ctx = setupTest();

  expect(() => readZfsPoolProperties(ctx.files, ctx.root)).toThrow(
    new DevError('cannot read deploy/zfs-pool.json'),
  );
});

test('it fails when the pool file gives zpool create no properties', () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.root, 'deploy', 'zfs-pool.json'), '{"create": []}');

  expect(() => readZfsPoolProperties(ctx.files, ctx.root)).toThrowWithMessage(
    DevError,
    /^deploy\/zfs-pool\.json: .*gives zpool create no properties/su,
  );
});
