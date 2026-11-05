import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const stubDirectory = mkdtempSync(join(tmpdir(), 'imp-embedded-shell-stub-'));

  onTestFinished(() => {
    rmSync(stubDirectory, { recursive: true, force: true });
  });

  const shellcheckPath = join(stubDirectory, 'shellcheck');

  return {
    shellcheckPath,
    runCheck: async () => {
      const result = await $`bun ${join(import.meta.dir, 'check-embedded-shell.ts')}`
        .cwd(join(import.meta.dir, '..', '..'))
        .env({ ...process.env, PATH: `${stubDirectory}:${process.env['PATH'] ?? ''}` })
        .nothrow()
        .quiet();

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    },
  };
}

test('it passes when shellcheck finds nothing in the embedded scripts', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.shellcheckPath, '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(ctx.shellcheckPath, 0o755);

  const result = await ctx.runCheck();

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it fails and names each embedded script that shellcheck finds a defect in', async () => {
  const ctx = setupTest();

  writeFileSync(ctx.shellcheckPath, '#!/usr/bin/env bash\necho "$@"\nexit 1\n');
  chmodSync(ctx.shellcheckPath, 0o755);

  const result = await ctx.runCheck();

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: [
      '--norc --shell=sh console-shell',
      '::error::shellcheck finds a defect in console-shell',
      '--norc --shell=sh mcp-write-script',
      '::error::shellcheck finds a defect in mcp-write-script',
      '--norc --shell=bash impz-completion.bash',
      '::error::shellcheck finds a defect in impz-completion.bash',
      '',
    ].join('\n'),
    stderr: '',
  });
});
