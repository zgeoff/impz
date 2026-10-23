import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRealPath } from './read-real-path.ts';

function setupTest() {
  const created = mkdtempSync(join(tmpdir(), 'imp-real-path-'));
  const directory = realpathSync(created);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { root: directory };
}

test('it follows a symlink before the .. that comes after it', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'artifacts', 'nested'), { recursive: true });
  symlinkSync(join(ctx.root, 'artifacts', 'nested'), join(ctx.root, 'alias'));
  writeFileSync(join(ctx.root, 'artifacts', 'vmlinux'), '');

  expect(readRealPath(`${ctx.root}/alias/../vmlinux`, '/')).toBe(
    join(ctx.root, 'artifacts', 'vmlinux'),
  );
});

test('it keeps the part of the path that does not exist as it is written', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'artifacts', 'nested'), { recursive: true });
  symlinkSync(join(ctx.root, 'artifacts', 'nested'), join(ctx.root, 'alias'));

  expect(readRealPath(join(ctx.root, 'alias', 'out', 'vmlinux'), '/')).toBe(
    join(ctx.root, 'artifacts', 'nested', 'out', 'vmlinux'),
  );
});

test('it reads a relative path from the folder it is given', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.root, 'kernel'));

  expect(readRealPath('kernel/../vmlinux', ctx.root)).toBe(join(ctx.root, 'vmlinux'));
});

test('it normalises a path none of which exists', () => {
  expect(readRealPath('/no-such-root-for-imp/a/../b', '/')).toBe('/no-such-root-for-imp/b');
});
