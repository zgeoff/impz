import { expect, test } from 'bun:test';
import { findTreeScript } from './find-tree-script';

test('it finds a script in scripts/release before an old copy in scripts/', () => {
  const files = new Set(['scripts/release/build-formula.sh', 'scripts/build-formula.sh']);

  expect(findTreeScript('build-formula.sh', (path) => files.has(path))).toBe(
    'scripts/release/build-formula.sh',
  );
});

test('it finds a script of a tag from before scripts/release/ in scripts/', () => {
  const files = new Set(['scripts/build-release-assets.sh']);

  expect(findTreeScript('build-release-assets.sh', (path) => files.has(path))).toBe(
    'scripts/build-release-assets.sh',
  );
});

test('it finds a script of a tag from before scripts/release/ in host/', () => {
  const files = new Set(['host/check-base-image.sh']);

  expect(findTreeScript('check-base-image.sh', (path) => files.has(path))).toBe(
    'host/check-base-image.sh',
  );
});

test('it finds nothing for a script the tree lacks', () => {
  const files = new Set(['scripts/release/build-formula.sh']);

  expect(findTreeScript('check-base-image.sh', (path) => files.has(path))).toBeNull();
});
