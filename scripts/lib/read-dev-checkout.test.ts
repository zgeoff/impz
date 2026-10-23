import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDevImageTag } from './build-dev-image-tag.ts';
import { readDevCheckout } from './read-dev-checkout.ts';

function setupTest() {
  const created = mkdtempSync(join(tmpdir(), 'imp-checkout-'));
  const directory = realpathSync(created);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it tags the host image for the checkout', () => {
  const ctx = setupTest();
  const root = join(ctx.directoryPath, 'imp');

  mkdirSync(root);

  expect(readDevCheckout(realpathSync, {}, root)).toStrictEqual({
    root,
    rootPhysical: root,
    hostImage: buildDevImageTag(root),
    buildDir: join(root, 'build'),
  });
});

test('it tags a checkout reached through a symlink by its real path', () => {
  const ctx = setupTest();
  const root = join(ctx.directoryPath, 'imp');
  const link = join(ctx.directoryPath, 'link');

  mkdirSync(root);
  symlinkSync(root, link);

  expect(readDevCheckout(realpathSync, {}, link).hostImage).toBe(buildDevImageTag(root));
});

test('it keeps the host image and build directory the environment sets', () => {
  const ctx = setupTest();

  expect(
    readDevCheckout(
      realpathSync,
      { IMP_HOST_IMAGE: 'imp-host:dev', IMP_BUILD: '/w/out' },
      ctx.directoryPath,
    ),
  ).toMatchObject({ hostImage: 'imp-host:dev', buildDir: '/w/out' });
});
