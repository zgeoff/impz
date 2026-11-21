import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFreeEnv } from '@impz/e2e-harness/create-git-free-env';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-build-base-image-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    tree: join(directory, 'tree'),
    env: { ...createGitFreeEnv(process.env), HOME: directory },
    scriptPath: join(import.meta.dir, 'build-base-image.ts'),
  };
}

test('it builds images/base for linux/amd64 alone, labelled with the commit checked out', async () => {
  const ctx = setupTest();

  await $`git init -q -b main ${ctx.tree}`.env(ctx.env).quiet();

  writeFileSync(join(ctx.tree, 'README.md'), 'base\n');

  await $`git -C ${ctx.tree} add README.md`.env(ctx.env).quiet();

  await $`git -C ${ctx.tree} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  const head = await $`git -C ${ctx.tree} rev-parse HEAD`.env(ctx.env).text();

  const revision = head.trim();

  createStubBin(ctx.directoryPath, 'docker');

  const result = await $`bun ${ctx.scriptPath}`
    .env({
      ...ctx.env,
      PATH: `${ctx.directoryPath}:${process.env['PATH'] ?? ''}`,
      BASE_IMAGE: 'ghcr.io/zgeoff/imp-base',
      PUSH_TAG: '2.0.1',
      VERSION: '2.0.1',
      SOURCE: 'https://github.com/zgeoff/impz',
      GITHUB_WORKSPACE: ctx.tree,
    })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    [
      `docker buildx build images/base --platform linux/amd64 --load --tag ghcr.io/zgeoff/imp-base:2.0.1 --label org.opencontainers.image.source=https://github.com/zgeoff/impz --label org.opencontainers.image.revision=${revision} --label org.opencontainers.image.version=2.0.1 --label org.opencontainers.image.description=imp base image: Ubuntu 24.04 with the Docker engine`,
      '',
    ].join('\n'),
  );

  expect(readStubCalls(ctx.directoryPath).map((call) => call.cwd)).toStrictEqual([ctx.tree]);
});
