import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShellcheck } from '@impz/test-utils/run-shellcheck';
import { CONSOLE_SHELL, buildConsoleShell } from './login-shell';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-login-shell-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('#buildConsoleShell runs the current user’s shell from the passwd file as a login shell', () => {
  const ctx = setupTest();
  const shell = join(ctx.directoryPath, 'user-shell');

  writeFileSync(shell, '#!/bin/sh\necho "user-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.directoryPath, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}\n`,
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.directoryPath, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect({ stdout: run.stdout.toString(), exitCode: run.exitCode }).toStrictEqual({
    stdout: 'user-shell -l\n',
    exitCode: 0,
  });
});

test('#buildConsoleShell skips the passwd entries of other users', () => {
  const ctx = setupTest();
  const other = join(ctx.directoryPath, 'other-shell');
  const shell = join(ctx.directoryPath, 'user-shell');

  writeFileSync(other, '#!/bin/sh\necho "other-shell $*"\n', { mode: 0o755 });
  writeFileSync(shell, '#!/bin/sh\necho "user-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.directoryPath, 'passwd'),
    [
      `other:x:${String((process.getuid?.() ?? 0) + 1)}:100::/home/other:${other}`,
      `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}`,
      '',
    ].join('\n'),
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.directoryPath, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('user-shell -l\n');
});

test('#buildConsoleShell falls back to the first executable fallback when the user’s shell is missing', () => {
  const ctx = setupTest();
  const fallback = join(ctx.directoryPath, 'fallback-shell');

  writeFileSync(fallback, '#!/bin/sh\necho "fallback-shell $*"\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.directoryPath, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${join(ctx.directoryPath, 'missing-shell')}\n`,
  );

  const run = Bun.spawnSync(
    [
      '/bin/sh',
      '-c',
      buildConsoleShell(join(ctx.directoryPath, 'passwd'), [
        join(ctx.directoryPath, 'no-such-shell'),
        fallback,
      ]),
    ],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('fallback-shell -l\n');
});

test('#buildConsoleShell falls back when the passwd file has no entry for the user', () => {
  const ctx = setupTest();
  const fallback = join(ctx.directoryPath, 'fallback-shell');

  writeFileSync(fallback, '#!/bin/sh\necho "fallback-shell $*"\n', { mode: 0o755 });
  writeFileSync(join(ctx.directoryPath, 'passwd'), '');

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.directoryPath, 'passwd'), [fallback])],
    { timeout: 5000 },
  );

  expect(run.stdout.toString()).toBe('fallback-shell -l\n');
});

test('#buildConsoleShell passes on the exit code of the login shell', () => {
  const ctx = setupTest();
  const shell = join(ctx.directoryPath, 'user-shell');

  writeFileSync(shell, '#!/bin/sh\nexit 3\n', { mode: 0o755 });

  writeFileSync(
    join(ctx.directoryPath, 'passwd'),
    `dev:x:${String(process.getuid?.())}:100::/home/dev:${shell}\n`,
  );

  const run = Bun.spawnSync(
    ['/bin/sh', '-c', buildConsoleShell(join(ctx.directoryPath, 'passwd'), ['/nonexistent/sh'])],
    { timeout: 5000 },
  );

  expect(run.exitCode).toBe(3);
});

test('#CONSOLE_SHELL reads /etc/passwd and falls back to bash, then sh', () => {
  expect(CONSOLE_SHELL).toBe(
    [
      'uid=$(id -u 2>/dev/null) || uid=0',
      'shell=',
      'while IFS=: read -r _ _ id _ _ _ login; do',
      '  if [ "$id" = "$uid" ]; then shell=$login; break; fi',
      'done < /etc/passwd',
      '[ -x "$shell" ] || shell=/bin/bash',
      '[ -x "$shell" ] || shell=/bin/sh',
      'exec "$shell" -l',
    ].join('\n'),
  );
});

test.skipIf(Bun.which('shellcheck') === null)(
  '#CONSOLE_SHELL passes shellcheck as POSIX sh',
  () => {
    expect(runShellcheck(CONSOLE_SHELL, 'sh')).toStrictEqual({ exitCode: 0, output: '' });
  },
);
