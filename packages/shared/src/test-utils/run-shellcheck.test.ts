import { expect, onTestFinished, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from './create-stub-bin';
import { runShellcheck } from './run-shellcheck';
import { updateEnv } from './update-env';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-shellcheck-stub-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it names the signal that ended shellcheck, with the time it ran', () => {
  const ctx = setupTest();
  const stub = createStubBin(ctx.directory, 'shellcheck', 'kill -KILL $$');

  updateEnv('PATH', `${stub.bin}:${process.env['PATH'] ?? ''}`);

  expect(() => runShellcheck('echo "$1"\n', 'sh')).toThrow(
    /^shellcheck ended on SIGKILL after \d+ ms$/u,
  );
});

test.skipIf(Bun.which('shellcheck') === null)('it reports no findings for a clean script', () => {
  expect(runShellcheck('echo "$1"\n', 'sh')).toStrictEqual({ exitCode: 0, output: '' });
});

test.skipIf(Bun.which('shellcheck') === null)(
  'it reports a finding with its code and a failed exit',
  () => {
    const result = runShellcheck('echo $1\n', 'sh');

    expect(result.exitCode).toBe(1);
    expect(result.output).toInclude('SC2086');
  },
);

test.skipIf(Bun.which('shellcheck') === null)('it accepts a [[ test as bash', () => {
  expect(runShellcheck('if [[ -n "$1" ]]; then echo "$1"; fi\n', 'bash')).toStrictEqual({
    exitCode: 0,
    output: '',
  });
});

test.skipIf(Bun.which('shellcheck') === null)('it refuses a [[ test as POSIX sh', () => {
  expect(runShellcheck('if [[ -n "$1" ]]; then echo "$1"; fi\n', 'sh').output).toInclude('SC3010');
});

test.skipIf(Bun.which('shellcheck') === null)('it removes its temp file once the test ends', () => {
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('imp-shellcheck-')),
  );

  runShellcheck('echo "$1"\n', 'sh');

  const directory = readdirSync(tmpdir()).find(
    (name) => name.startsWith('imp-shellcheck-') && !before.has(name),
  );

  onTestFinished(() => {
    const path = join(tmpdir(), directory ?? '');

    expect(directory).toBeString();
    expect(existsSync(path)).toBeFalse();
  });
});
