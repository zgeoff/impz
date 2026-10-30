import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubPackScript } from './create-stub-pack-script';

function setupTest() {
  const created = mkdtempSync(join(tmpdir(), 'imp-stub-pack-script-'));
  const directory = realpathSync(created);

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'scripts'));

  return { tree: directory, folder: join(directory, 'scripts') };
}

test('it writes the tarball under build/npm/ of the directory it runs in, and prints its path', () => {
  const ctx = setupTest();

  createStubPackScript(ctx.folder, 'pack-client.sh', 'impz-client-3.1.4.tgz');

  const result = Bun.spawnSync([join(ctx.folder, 'pack-client.sh')], { cwd: ctx.tree });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.tree}/build/npm/impz-client-3.1.4.tgz\n`,
  });

  expect(readFileSync(join(ctx.tree, 'build', 'npm', 'impz-client-3.1.4.tgz'), 'utf8')).toBe(
    'impz-client-3.1.4.tgz\n',
  );
});
