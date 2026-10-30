import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveTreeScript } from './resolve-tree-script';

function setupTest() {
  const tree = mkdtempSync(join(tmpdir(), 'imp-tree-script-'));

  onTestFinished(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  return { tree };
}

test('it resolves a script in scripts/release before an old copy in scripts/', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });
  writeFileSync(join(ctx.tree, 'scripts', 'release', 'build-formula.sh'), '');
  writeFileSync(join(ctx.tree, 'scripts', 'build-formula.sh'), '');

  expect(resolveTreeScript(ctx.tree, 'build-formula.sh')).toBe('scripts/release/build-formula.sh');
});

test('it resolves a script of a tag from before scripts/release/ in scripts/', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts'));
  writeFileSync(join(ctx.tree, 'scripts', 'build-release-assets.sh'), '');

  expect(resolveTreeScript(ctx.tree, 'build-release-assets.sh')).toBe(
    'scripts/build-release-assets.sh',
  );
});

test('it resolves a script of a tag from before scripts/release/ in host/', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'host'));
  writeFileSync(join(ctx.tree, 'host', 'check-base-image.sh'), '');

  expect(resolveTreeScript(ctx.tree, 'check-base-image.sh')).toBe('host/check-base-image.sh');
});

test('it resolves nothing for a script the tree lacks', () => {
  const ctx = setupTest();

  expect(resolveTreeScript(ctx.tree, 'check-base-image.sh')).toBeNull();
});
