import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubCLIBinary } from './build-stub-cli-binary';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-cli-binary-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { binary: join(directory, 'impz') };
}

test('it prints its version for --version', () => {
  const ctx = setupTest();

  writeFileSync(ctx.binary, buildStubCLIBinary({ version: '3.1.4' }), { mode: 0o755 });

  const result = Bun.spawnSync([ctx.binary, '--version']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '3.1.4\n',
  });
});

test.each([['bash'], ['zsh'], ['fish']])('it prints its %s completion', (shell) => {
  const ctx = setupTest();

  writeFileSync(ctx.binary, buildStubCLIBinary({ version: '3.1.4' }), { mode: 0o755 });

  expect(Bun.spawnSync([ctx.binary, 'completion', shell]).exitCode).toBe(0);
});

test('it fails the completion it is told to fail', () => {
  const ctx = setupTest();

  writeFileSync(ctx.binary, buildStubCLIBinary({ version: '3.1.4', failingCompletion: 'zsh' }), {
    mode: 0o755,
  });

  expect(Bun.spawnSync([ctx.binary, 'completion', 'zsh']).exitCode).toBe(1);
});

test('it prints the other completions when one fails', () => {
  const ctx = setupTest();

  writeFileSync(ctx.binary, buildStubCLIBinary({ version: '3.1.4', failingCompletion: 'zsh' }), {
    mode: 0o755,
  });

  expect(Bun.spawnSync([ctx.binary, 'completion', 'bash']).exitCode).toBe(0);
});
