import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFreeEnv } from '@impz/e2e-harness/create-git-free-env';
import { createStubBin } from '@zgeoff/testing/bin';
import { $ } from 'bun';
import { buildStubGhRepoClone } from './build-stub-gh-repo-clone';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-gh-clone-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    env: { ...createGitFreeEnv(process.env), HOME: directory },
  };
}

test('it clones the given remote into the folder gh repo clone names', async () => {
  const ctx = setupTest();
  const seed = join(ctx.directoryPath, 'seed');
  const remote = join(ctx.directoryPath, 'tap.git');

  await $`git init -q -b main ${seed}`.env(ctx.env).quiet();

  writeFileSync(join(seed, 'README.md'), 'tap\n');

  await $`git -C ${seed} add README.md`.env(ctx.env).quiet();

  await $`git -C ${seed} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  await $`git clone -q --bare ${seed} ${remote}`.env(ctx.env).quiet();

  createStubBin(ctx.directoryPath, 'gh', { script: buildStubGhRepoClone(remote) });

  const clone = join(ctx.directoryPath, 'clone');

  const result = await $`gh repo clone example/homebrew-tap ${clone}`
    .env({ ...ctx.env, PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(clone, 'README.md'), 'utf8')).toBe('tap\n');
});

test('it makes an empty folder for no remote', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'gh', { script: buildStubGhRepoClone(null) });

  const clone = join(ctx.directoryPath, 'clone');

  const result = await $`gh repo clone example/homebrew-tap ${clone}`
    .env({ ...ctx.env, PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
  expect(readdirSync(clone)).toStrictEqual([]);
});

test('it passes any other gh command without cloning', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'gh', { script: buildStubGhRepoClone(null) });

  const result = await $`gh auth setup-git`
    .env({ ...ctx.env, PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}` })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  // a clone would leave a folder beside the stand-in and its record
  const folders = readdirSync(ctx.directoryPath).filter(
    (name) => !name.startsWith('.') && name !== 'gh' && name !== 'calls.jsonl',
  );

  expect(folders).toStrictEqual([]);
});
