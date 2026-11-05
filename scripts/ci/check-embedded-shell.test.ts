import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readText } from '@impz/daemon/read-text';
import { stopSuiteGroup } from '@impz/e2e-harness/run-suite';
import { createStubBin } from '@impz/test-utils/create-stub-bin';

function setupTest() {
  const stack = new AsyncDisposableStack();

  onTestFinished(() => stack.disposeAsync());

  const stubDirectory = mkdtempSync(join(tmpdir(), 'imp-embedded-shell-stub-'));

  stack.defer(() => {
    rmSync(stubDirectory, { recursive: true, force: true });
  });

  return {
    stubDirectory,
    runCheck: async (stubBin: string) => {
      const check = Bun.spawn(['bun', join(import.meta.dir, 'check-embedded-shell.ts')], {
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, PATH: `${stubBin}:${process.env['PATH'] ?? ''}` },
        stdout: 'pipe',
        stderr: 'pipe',
        detached: true,
      });

      stack.defer(async () => {
        stopSuiteGroup(check.pid, 'SIGTERM');

        await check.exited;
      });

      const [exitCode, stdout, stderr] = await Promise.all([
        check.exited,
        new Response(check.stdout).text(),
        new Response(check.stderr).text(),
      ]);

      return { exitCode, stdout, stderr };
    },
  };
}

test('it passes when shellcheck finds nothing in the embedded scripts', async () => {
  const ctx = setupTest();
  const shellcheck = createStubBin(ctx.stubDirectory, 'shellcheck', 'exit 0');

  const result = await ctx.runCheck(shellcheck.bin);

  expect(result).toStrictEqual({ exitCode: 0, stdout: '', stderr: '' });
});

test('it checks each embedded script in its own dialect', async () => {
  const ctx = setupTest();
  const shellcheck = createStubBin(ctx.stubDirectory, 'shellcheck', 'exit 0');

  await ctx.runCheck(shellcheck.bin);

  expect(readText(shellcheck.calls)).toBe(
    [
      'shellcheck --norc --shell=sh console-shell',
      'shellcheck --norc --shell=sh mcp-write-script',
      'shellcheck --norc --shell=bash impz-completion.bash',
      '',
    ].join('\n'),
  );
});

test('it fails and names each embedded script that shellcheck finds a defect in', async () => {
  const ctx = setupTest();
  const shellcheck = createStubBin(ctx.stubDirectory, 'shellcheck', 'exit 1');

  const result = await ctx.runCheck(shellcheck.bin);

  expect(result).toStrictEqual({
    exitCode: 1,
    stdout: [
      '::error::shellcheck finds a defect in console-shell',
      '::error::shellcheck finds a defect in mcp-write-script',
      '::error::shellcheck finds a defect in impz-completion.bash',
      '',
    ].join('\n'),
    stderr: '',
  });
});
