import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const created = mkdtempSync(join(tmpdir(), 'imp-run-tree-script-'));
  const tree = realpathSync(created);

  onTestFinished(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  return { tree, scriptPath: join(import.meta.dir, 'run-tree-script.ts') };
}

test('it runs the tree script of an old tag in the tree, with the arguments it was given', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts'));

  writeFileSync(
    join(ctx.tree, 'scripts', 'build-release-assets.sh'),
    '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@"\n',
    { mode: 0o755 },
  );

  const result =
    await $`bun ${ctx.scriptPath} build-release-assets.sh -- --cache-from ${'type=gha,scope=system files'}`
      .env({ ...process.env, GITHUB_WORKSPACE: ctx.tree })
      .nothrow()
      .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: `${ctx.tree}\n--cache-from\ntype=gha,scope=system files\n`,
  });
});

test('it exits with the exit code of a tree script that fails', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts', 'release'), { recursive: true });

  writeFileSync(
    join(ctx.tree, 'scripts', 'release', 'check-release-image.sh'),
    '#!/bin/sh\nexit 3\n',
    {
      mode: 0o755,
    },
  );

  const result = await $`bun ${ctx.scriptPath} check-release-image.sh`
    .env({ ...process.env, GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(3);
});

test('it refuses a flag before --, and runs nothing', async () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.tree, 'scripts'));

  writeFileSync(join(ctx.tree, 'scripts', 'build-release.sh'), '#!/bin/sh\necho built\n', {
    mode: 0o755,
  });

  const result = await $`bun ${ctx.scriptPath} build-release.sh --cache-from type=gha`
    .env({ ...process.env, GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 2,
    stdout: '',
    stderr: 'usage: run-tree-script.ts <script name> [-- args...]\n',
  });
});

test('it fails for a script the tree lacks', async () => {
  const ctx = setupTest();

  const result = await $`bun ${ctx.scriptPath} check-base-image.sh`
    .env({ ...process.env, GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'the checked-out tree has no check-base-image.sh in scripts/release, scripts or host\n',
  });
});
