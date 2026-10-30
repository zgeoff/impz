import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const tree = mkdtempSync(join(tmpdir(), 'imp-check-cli-binary-'));

  onTestFinished(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  mkdirSync(join(tree, 'dist'));

  return {
    tree,
    dist: join(tree, 'dist'),
    scriptPath: join(import.meta.dir, 'check-cli-binary.ts'),
  };
}

test('it passes a binary at its version whose sum SHA256SUMS lists', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\n[ "$1" = --version ] && echo 2.0.1\nexit 0\n';

  writeFileSync(join(ctx.dist, 'impz-linux-x64'), binary);

  writeFileSync(
    join(ctx.dist, 'SHA256SUMS'),
    `${'1'.repeat(64)}  impz-linux-arm64\n${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  impz-linux-x64\n`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'impz-linux-x64 is 2.0.1, matches SHA256SUMS and prints its completions\n',
  });
});

test('it checks the imp binary of a tag from before the rename', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\n[ "$1" = --version ] && echo 1.6.0\nexit 0\n';

  writeFileSync(join(ctx.dist, 'imp-darwin-arm64'), binary);

  writeFileSync(
    join(ctx.dist, 'SHA256SUMS'),
    `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  imp-darwin-arm64\n`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'darwin-arm64', VERSION: '1.6.0', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);
});

test('it fails a binary whose sum differs from SHA256SUMS', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 2.0.1\n';

  writeFileSync(join(ctx.dist, 'impz-linux-x64'), binary);
  writeFileSync(join(ctx.dist, 'SHA256SUMS'), `${'1'.repeat(64)}  impz-linux-x64\n`);

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `impz-linux-x64 has sha256 ${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}, and SHA256SUMS lists ${'1'.repeat(64)} for it\n`,
  });
});

test('it fails a binary that SHA256SUMS leaves out', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 2.0.1\n';

  writeFileSync(join(ctx.dist, 'impz-linux-x64'), binary);
  writeFileSync(join(ctx.dist, 'SHA256SUMS'), `${'1'.repeat(64)}  impz-linux-x64.old\n`);

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: `impz-linux-x64 has sha256 ${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}, and SHA256SUMS lists no sum for it\n`,
  });
});

test('it fails a binary that reports another version', async () => {
  const ctx = setupTest();
  const binary = '#!/bin/sh\necho 2.0.0\n';

  writeFileSync(join(ctx.dist, 'impz-linux-x64'), binary);

  writeFileSync(
    join(ctx.dist, 'SHA256SUMS'),
    `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  impz-linux-x64\n`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'impz-linux-x64 --version is 2.0.0, want 2.0.1\n',
  });
});

test('it fails a binary that cannot print a completion', async () => {
  const ctx = setupTest();

  const binary =
    '#!/bin/sh\n[ "$1" = --version ] && echo 2.0.1 && exit 0\n[ "$2" = fish ] && exit 1\nexit 0\n';

  writeFileSync(join(ctx.dist, 'impz-linux-x64'), binary);

  writeFileSync(
    join(ctx.dist, 'SHA256SUMS'),
    `${new Bun.CryptoHasher('sha256').update(binary).digest('hex')}  impz-linux-x64\n`,
  );

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(1);
});

test('it fails when dist/ holds no binary for the target', async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.dist, 'SHA256SUMS'), '');

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, TARGET: 'linux-x64', VERSION: '2.0.1', GITHUB_WORKSPACE: ctx.tree })
    .nothrow()
    .quiet();

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'dist/ holds neither impz-linux-x64 nor imp-linux-x64\n',
  });
});
