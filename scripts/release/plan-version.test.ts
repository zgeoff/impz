import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-plan-version-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');

  return {
    tree: directory,
    outputs: join(directory, 'outputs'),
    scriptPath: join(import.meta.dir, 'plan-version.ts'),
  };
}

test('it takes the version of a release from its tag', async () => {
  const ctx = setupTest();

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TAG: 'v1.2.3', GITHUB_OUTPUT: ctx.outputs })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('version=1.2.3\npush_tag=1.2.3\n');
});

test('it takes the version of a dry run from package.json, and pushes it under its commit', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.tree, 'package.json'), '{ "name": "impz", "version": "6.2.0" }\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      TAG: '',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('version=6.2.0\npush_tag=dryrun-0123456789ab\n');
});

test.each([['1.2.3'], ['v1.2'], ['v1.2.3-rc.1'], ['main']])(
  'it refuses the tag %s, planning nothing',
  async (tag) => {
    const ctx = setupTest();

    const result = await $`bun ${ctx.scriptPath}`
      .env({ ...process.env, TAG: tag, GITHUB_OUTPUT: ctx.outputs })
      .nothrow()
      .quiet();

    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
      exitCode: 1,
      stderr: `tag ${tag} is not vX.Y.Z\n`,
    });

    expect(readFileSync(ctx.outputs, 'utf8')).toBe('');
  },
);

test('it fails a dry run of a tree whose package.json holds no version', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.tree, 'package.json'), '{ "name": "impz" }\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      TAG: '',
      GITHUB_OUTPUT: ctx.outputs,
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'package.json holds no version\n',
  });
});
