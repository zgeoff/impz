import { expect, onTestFinished, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGitChecked, runGitCommand } from '../../e2e/lib/git-env';

const CODEMOD = join(import.meta.dir, 'nest-daemon-layers.ts');

async function setupTest() {
  const root = await mkdtemp(join(tmpdir(), 'nest-daemon-layers-'));

  onTestFinished(() => rm(root, { recursive: true, force: true }));

  await runGitChecked(['git', '-C', root, 'init', '--quiet']);

  return { root };
}

test('it moves a daemon file that git does not track yet', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const readImp = 1;\n');

  const result = await runGitCommand([process.execPath, CODEMOD, ctx.root]);

  expect(result).toStrictEqual({
    exitCode: 0,
    stdout: 'moved 1 files, rewrote 0 files\n',
    stderr: '',
  });

  expect(existsSync(join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'))).toBeTrue();
});

test('it exits 1 and names a daemon file that no layer covers', async () => {
  const ctx = await setupTest();

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/quotas/quota.ts'),
    'export const quota = 1;\n',
  );

  const result = await runGitCommand([process.execPath, CODEMOD, ctx.root]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: 'moved 0 files, rewrote 0 files\n',
    stderr:
      'unplaced: packages/daemon/src/quotas/quota.ts (add it to the layer table in plan-layer-path.ts)\n',
  });
});

test('it exits 1 and names the rewritten files when oxfmt fails on them', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const readImp = 1;\n');

  await Bun.write(
    join(ctx.root, 'packages/cli/src/broken.ts'),
    "import { readImp } from '../../daemon/src/db/imps';\nconst = ;\n",
  );

  const result = await runGitCommand([process.execPath, CODEMOD, ctx.root]);

  expect(result.exitCode).toBe(1);

  expect(result.stderr).toEndWith(
    'oxfmt exited 2; fix and format these files:\n  packages/cli/src/broken.ts\n',
  );
});

test('it exits 1 and moves no file when a destination already holds one', async () => {
  const ctx = await setupTest();

  await Bun.write(join(ctx.root, 'packages/daemon/src/db/imps.ts'), 'export const old = 1;\n');

  await Bun.write(
    join(ctx.root, 'packages/daemon/src/platform/db/imps.ts'),
    'export const placed = 1;\n',
  );

  const result = await runGitCommand([process.execPath, CODEMOD, ctx.root]);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: [
      'collision: packages/daemon/src/db/imps.ts moves to packages/daemon/src/platform/db/imps.ts, which a file already holds',
      'moved no file: merge or remove each colliding pair, then run again',
      '',
    ].join('\n'),
  });

  expect(existsSync(join(ctx.root, 'packages/daemon/src/db/imps.ts'))).toBeTrue();
});
