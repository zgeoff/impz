import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';
import { buildStubNpmView } from '../test-utils/build-stub-npm-view';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-plan-npm-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'outputs'), '');
  mkdirSync(join(directory, 'tree'));

  return {
    directoryPath: directory,
    tree: join(directory, 'tree'),
    outputs: join(directory, 'outputs'),
    scriptPath: join(import.meta.dir, 'plan-npm-packages.ts'),
  };
}

test('it plans both packages of the newest release under latest', async () => {
  const ctx = setupTest();
  const npm = createStubBin(ctx.directoryPath, 'npm', 'echo "npm error code E404" >&2\nexit 1');

  mkdirSync(join(ctx.tree, 'packages', 'testing'), { recursive: true });
  writeFileSync(join(ctx.tree, 'packages', 'testing', 'package.json'), '{}\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${npm.bin}:${process.env['PATH'] ?? ''}`,
      VERSION: '2.0.1',
      IS_NEWEST: 'true',
      TESTING_ENABLED: 'true',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'client=true\ntesting=true\ndist_tag=latest\npublish=true\n',
  );

  expect(readFileSync(npm.calls, 'utf8')).toBe(
    'npm view @impz/client@2.0.1 version\nnpm view @impz/testing@2.0.1 version\n',
  );
});

test('it plans a republish of an older release under previous', async () => {
  const ctx = setupTest();
  const npm = createStubBin(ctx.directoryPath, 'npm', 'exit 1');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${npm.bin}:${process.env['PATH'] ?? ''}`,
      VERSION: '2.0.0',
      IS_NEWEST: 'false',
      TESTING_ENABLED: 'false',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'client=true\ntesting=false\ndist_tag=previous\npublish=true\n',
  );
});

test('it plans the client alone for a tag with no packages/testing', async () => {
  const ctx = setupTest();
  const npm = createStubBin(ctx.directoryPath, 'npm', 'exit 1');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${npm.bin}:${process.env['PATH'] ?? ''}`,
      VERSION: '1.6.0',
      IS_NEWEST: 'true',
      TESTING_ENABLED: 'true',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'client=true\ntesting=false\ndist_tag=latest\npublish=true\n',
  );

  expect(readFileSync(npm.calls, 'utf8')).toBe('npm view @impz/client@1.6.0 version\n');
});

test('it skips a package whose version is on npm already', async () => {
  const ctx = setupTest();
  const npm = createStubBin(ctx.directoryPath, 'npm', buildStubNpmView(['@impz/client@2.0.1']));

  mkdirSync(join(ctx.tree, 'packages', 'testing'), { recursive: true });
  writeFileSync(join(ctx.tree, 'packages', 'testing', 'package.json'), '{}\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${npm.bin}:${process.env['PATH'] ?? ''}`,
      VERSION: '2.0.1',
      IS_NEWEST: 'true',
      TESTING_ENABLED: 'true',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: '@impz/client@2.0.1 is on npm already\n',
  });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'client=false\ntesting=true\ndist_tag=latest\npublish=true\n',
  );
});

test('it publishes nothing when every planned version is on npm already', async () => {
  const ctx = setupTest();
  const npm = createStubBin(ctx.directoryPath, 'npm', 'echo 2.0.1');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...process.env,
      PATH: `${npm.bin}:${process.env['PATH'] ?? ''}`,
      VERSION: '2.0.1',
      IS_NEWEST: 'true',
      TESTING_ENABLED: 'false',
      GITHUB_WORKSPACE: ctx.tree,
      GITHUB_OUTPUT: ctx.outputs,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(ctx.outputs, 'utf8')).toBe('client=false\ntesting=false\npublish=false\n');
});
