import { expect, onTestFinished, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitFreeEnv } from '@impz/e2e-harness/git-env';
import { $ } from 'bun';

async function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-generated-protocol-'));
  const env = { ...createGitFreeEnv(process.env), HOME: directory };

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  await $`git init -q -b main ${directory}`.env(env).quiet();

  return {
    checkout: directory,
    env,
    scriptPath: join(import.meta.dir, 'check-generated-protocol.ts'),
  };
}

test('it passes when the generator leaves the generated code as committed', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.checkout, 'docs', 'reference'), { recursive: true });
  writeFileSync(join(ctx.checkout, 'docs', 'reference', 'agent-protocol.md'), '# Agent protocol\n');

  writeFileSync(
    join(ctx.checkout, 'package.json'),
    '{ "scripts": { "gen:proto": "echo \'# Agent protocol\' > docs/reference/agent-protocol.md" } }\n',
  );

  await $`git -C ${ctx.checkout} add .`.env(ctx.env).quiet();

  await $`git -C ${ctx.checkout} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  const result = await $`bun ${ctx.scriptPath}`.cwd(ctx.checkout).env(ctx.env).nothrow().quiet();

  expect(result.exitCode).toBe(0);
});

test('it fails, listing what changed, when the generator rewrites the generated code', async () => {
  const ctx = await setupTest();

  mkdirSync(join(ctx.checkout, 'docs', 'reference'), { recursive: true });
  writeFileSync(join(ctx.checkout, 'docs', 'reference', 'agent-protocol.md'), '# Old protocol\n');

  writeFileSync(
    join(ctx.checkout, 'package.json'),
    '{ "scripts": { "gen:proto": "mkdir -p packages/agent-protocol/src/gen && echo export {} > packages/agent-protocol/src/gen/frames.ts && echo \'# Agent protocol\' > docs/reference/agent-protocol.md" } }\n',
  );

  await $`git -C ${ctx.checkout} add .`.env(ctx.env).quiet();

  await $`git -C ${ctx.checkout} -c user.name=seed -c user.email=seed@example.test commit -q -m seed`
    .env(ctx.env)
    .quiet();

  const result = await $`bun ${ctx.scriptPath}`.cwd(ctx.checkout).env(ctx.env).nothrow().quiet();

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 1,
    stdout: [
      ' M docs/reference/agent-protocol.md',
      '?? packages/agent-protocol/src/gen/',
      '::error::the generated protocol code differs from proto/; run bun run gen:proto',
      '',
    ].join('\n'),
  });
});
