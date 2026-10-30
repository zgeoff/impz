import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-read-sync-tag-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  mkdirSync(join(directory, 'checkout', '.github', 'workflows'), { recursive: true });
  writeFileSync(join(directory, 'outputs'), '');

  return {
    checkout: join(directory, 'checkout'),
    outputs: join(directory, 'outputs'),
    scriptPath: join(import.meta.dir, 'read-sync-tag.ts'),
  };
}

test("it outputs the sync tag that repo-sync's sync job calls", async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.checkout, '.github', 'workflows', 'repo-sync.yml'),
    'jobs:\n  sync:\n    uses: zgeoff/tools/.github/workflows/repo-sync.yml@sync-v41\n',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .cwd(ctx.checkout)
    .env({ GITHUB_OUTPUT: ctx.outputs })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('ref=sync-v41\n');
});

test('it fails, outputting nothing, when the sync job calls no sync tag', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.checkout, '.github', 'workflows', 'repo-sync.yml'),
    'jobs:\n  sync:\n    uses: zgeoff/tools/.github/workflows/repo-sync.yml@main\n',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .cwd(ctx.checkout)
    .env({ GITHUB_OUTPUT: ctx.outputs })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr:
      "repo-sync.yml's sync job calls no zgeoff/tools sync tag: zgeoff/tools/.github/workflows/repo-sync.yml@main\n",
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});

test('it fails when repo-sync.yml has no sync job', async () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.checkout, '.github', 'workflows', 'repo-sync.yml'),
    'jobs:\n  audit:\n    runs-on: ubuntu-latest\n',
  );

  const result = await $`${process.execPath} ${ctx.scriptPath}`
    .cwd(ctx.checkout)
    .env({ GITHUB_OUTPUT: ctx.outputs })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
});
