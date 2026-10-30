import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubDevScript } from './create-stub-dev-script';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-dev-script-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    checkout: join(directory, 'checkout'),
    calls: join(directory, 'calls'),
  };
}

test('it prints its token for dev.sh token, and records the call', () => {
  const ctx = setupTest();

  createStubDevScript(ctx.checkout, ctx.calls, 'tok_example');

  const result = Bun.spawnSync([join(ctx.checkout, 'scripts', 'dev', 'dev.sh'), 'token']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'tok_example\n',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('dev.sh token\n');
});

test('it passes any other command with no output, and records it', () => {
  const ctx = setupTest();

  createStubDevScript(ctx.checkout, ctx.calls, 'tok_example');

  const result = Bun.spawnSync([join(ctx.checkout, 'scripts', 'dev', 'dev.sh'), 'up']);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });

  expect(readFileSync(ctx.calls, 'utf8')).toBe('dev.sh up\n');
});
